#!/usr/bin/env python3
"""Validate the SnowHarness documentation and machine-readable contract set."""

from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[3]
DOCS_ROOT = REPO_ROOT / "docs" / "architecture"
CONTRACTS = REPO_ROOT / "docs" / "contracts"
API_DOCS = [
    DOCS_ROOT / "api-and-events.md",
    DOCS_ROOT / "capability-and-collaboration-api.md",
    DOCS_ROOT / "memory-and-job-api.md",
    DOCS_ROOT / "security.md",
]
HTTP_LINE = re.compile(r"^`(GET|POST|PUT|PATCH|DELETE) ([^`]+)`$", re.MULTILINE)
ERROR_ROW = re.compile(r"^\|\s*([A-Z][A-Z0-9_]+)\s*\|\s*(\d{3})\s*\|", re.MULTILINE)
EVENT_NAME = re.compile(r"^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$")


def fail(message: str) -> None:
    raise AssertionError(message)


def load_json(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        fail(f"invalid JSON {path.relative_to(REPO_ROOT)}: {exc}")


def validate_manifest() -> None:
    manifest = load_json(CONTRACTS / "contract-manifest.json")
    seen: set[str] = set()
    for artifact in manifest["artifacts"]:
        path = artifact["path"]
        if path in seen:
            fail(f"duplicate manifest artifact: {path}")
        seen.add(path)
        if not (CONTRACTS / path).is_file():
            fail(f"missing manifest artifact: {path}")


def validate_openapi() -> int:
    result = subprocess.run(
        [sys.executable, str(CONTRACTS / "scripts" / "generate_openapi.py"), "--check"],
        cwd=REPO_ROOT,
        text=True,
        capture_output=True,
    )
    if result.returncode:
        fail(result.stderr.strip() or result.stdout.strip())
    contract = load_json(CONTRACTS / "openapi.json")
    if contract.get("openapi") != "3.1.0":
        fail("OpenAPI version must be 3.1.0")
    operation_ids: set[str] = set()
    known_error_codes = set(load_json(CONTRACTS / "error-codes.json")["errors"])
    operation_count = 0
    post_query_exceptions = {"/gateway/v1/context/query"}
    for path, path_item in contract["paths"].items():
        if not path.startswith("/"):
            fail(f"invalid OpenAPI path: {path}")
        for method, operation in path_item.items():
            if method not in {"get", "post", "put", "patch", "delete"}:
                continue
            operation_count += 1
            operation_id = operation.get("operationId")
            if not operation_id or operation_id in operation_ids:
                fail(f"missing or duplicate operationId: {operation_id}")
            operation_ids.add(operation_id)
            if not operation.get("x-snowharness-doc"):
                fail(f"operation missing x-snowharness-doc: {operation_id}")
            operation_errors = set(operation.get("x-snowharness-error-codes", []))
            if not operation_errors or not operation_errors.issubset(known_error_codes):
                fail(f"operation has missing/unknown error codes: {operation_id}")
            if "default" not in operation.get("responses", {}):
                fail(f"operation missing error response: {operation_id}")
            if method == "post" and path not in post_query_exceptions:
                headers = {
                    item["name"].lower()
                    for item in operation.get("parameters", [])
                    if item.get("in") == "header"
                }
                if "idempotency-key" not in headers:
                    fail(f"mutating POST missing Idempotency-Key: {operation_id}")
            if method in {"put", "patch"}:
                # S01-W02: 可编辑资源必须声明 ETag/If-Match，冲突返回 412。
                if_match = next(
                    (
                        item
                        for item in operation.get("parameters", [])
                        if item.get("in") == "header"
                        and item.get("name", "").lower() == "if-match"
                    ),
                    None,
                )
                if not if_match or not if_match.get("required"):
                    fail(f"editable {method.upper()} missing required If-Match: {operation_id}")
            if method == "get" and path.endswith("/events"):
                success = [value for key, value in operation["responses"].items() if key != "default"]
                media_types = set(success[0].get("content", {}))
                if media_types != {"text/event-stream"}:
                    fail(f"SSE operation has wrong media type: {operation_id}")
    documented_count = sum(len(HTTP_LINE.findall(path.read_text(encoding="utf-8"))) for path in API_DOCS)
    if operation_count != documented_count:
        fail(f"OpenAPI/document operation mismatch: {operation_count} != {documented_count}")
    if contract.get("x-snowharness-operation-count") != operation_count:
        fail("x-snowharness-operation-count is stale")
    return operation_count


def validate_events() -> int:
    schema = load_json(CONTRACTS / "event-envelope.schema.json")
    required = set(schema.get("required", []))
    expected = {"event_id", "stream_type", "sequence", "event_type", "schema_version", "actor", "occurred_at", "payload"}
    if not expected.issubset(required):
        fail("event envelope missing required fields")
    catalog = load_json(CONTRACTS / "event-catalog.json")
    events = catalog.get("events", {})
    if not events:
        fail("event catalog is empty")
    for name, definition in events.items():
        if not EVENT_NAME.fullmatch(name):
            fail(f"invalid event name: {name}")
        if not definition.get("streams") or not set(definition["streams"]).issubset({"thread", "job"}):
            fail(f"invalid event streams: {name}")
        if definition.get("version", 0) < 1:
            fail(f"invalid event version: {name}")
        refs = set(definition.get("required_refs", []))
        if "thread" in definition["streams"] and "job" not in definition["streams"] and "thread_id" not in refs:
            fail(f"thread event missing thread_id requirement: {name}")
        if "job" in definition["streams"] and "thread" not in definition["streams"] and "job_id" not in refs:
            fail(f"job event missing job_id requirement: {name}")
    never_skippable = ("completed", "failed", "cancelled", "deleted", "blocked", "effect_unknown")
    for name, definition in events.items():
        if any(token in name for token in never_skippable) and definition.get("skippable_for_projection"):
            fail(f"terminal/security event cannot be skippable: {name}")
    return len(events)


def validate_errors() -> int:
    catalog = load_json(CONTRACTS / "error-codes.json").get("errors", {})
    if not catalog:
        fail("error catalog is empty")
    for code, definition in catalog.items():
        if not re.fullmatch(r"[A-Z][A-Z0-9_]+", code):
            fail(f"invalid error code: {code}")
        if definition.get("http") not in {400, 401, 403, 404, 409, 412, 413, 422, 429, 500, 503}:
            fail(f"invalid error HTTP status: {code}")
        if not isinstance(definition.get("retryable"), bool):
            fail(f"error retryable must be boolean: {code}")
    documented: dict[str, int] = {}
    for path in API_DOCS:
        for code, http in ERROR_ROW.findall(path.read_text(encoding="utf-8")):
            documented[code] = int(http)
    missing = sorted(set(documented) - set(catalog))
    if missing:
        fail(f"documented error codes missing from catalog: {', '.join(missing)}")
    mismatched = sorted(code for code, http in documented.items() if catalog[code]["http"] != http)
    if mismatched:
        fail(f"error HTTP mismatch: {', '.join(mismatched)}")
    return len(catalog)


def _validate_case_list(cases: list, kind: str) -> None:
    ids = [case.get("id") for case in cases]
    if not ids:
        fail(f"{kind} conformance suite is empty")
    if len(ids) != len(set(ids)) or any(not item for item in ids):
        fail(f"{kind} conformance case ids must be unique and non-empty")
    for case in cases:
        if not case.get("given") or not case.get("when") or len(case.get("expect", [])) < 1:
            fail(f"incomplete {kind} conformance case: {case.get('id')}")


def validate_conformance() -> int:
    """校验 Runtime Publication Conformance 与 Platform Integration Conformance 两份合同。

    - runtime-conformance.json：RuntimeRevision Publication Gate 的正式套件（6 个协议/Adapter case）。
    - platform-integration-conformance.json：平台级不变量套件（CI / 集成测试，不阻断 Publication）。
    """
    publication = load_json(CONTRACTS / "runtime-conformance.json")
    integration = load_json(CONTRACTS / "platform-integration-conformance.json")

    publication_cases = publication.get("required_cases", [])
    integration_cases = integration.get("required_cases", [])

    _validate_case_list(publication_cases, "runtime publication")
    _validate_case_list(integration_cases, "platform integration")

    # Publication 套件不得把平台级不变量（Route/Binding/Event Ingress/Tool/Memory/
    # Child Thread/Credential/Ownership）当作 Adapter 协议 case。
    platform_only = {
        "dispatch-binds-immutable-config",
        "event-batch-idempotent",
        "event-payload-hash-conflict",
        "attempt-sequence-continuity",
        "tool-schema-refresh",
        "unknown-effect-no-replay",
        "capability-search-not-use",
        "memory-proposal-only",
        "child-thread-isolation",
        "child-cancel-requires-ack",
        "credential-never-in-model-data",
        "execution-ownership-epoch",
        "steer-requires-ack",
        "unsupported-steer",
        "cancel-request-not-terminal",
    }
    pub_ids = {case.get("id") for case in publication_cases}
    overlap = sorted(platform_only & pub_ids)
    if overlap:
        fail(
            "runtime publication conformance must not contain platform-only cases: "
            + ", ".join(overlap)
        )

    # Platform 套件必须覆盖全部平台级不变量。
    missing_platform = sorted(platform_only - {case.get("id") for case in integration_cases})
    if missing_platform:
        fail(
            "platform integration conformance missing platform cases: "
            + ", ".join(missing_platform)
        )

    return len(publication_cases) + len(integration_cases)


def validate_cross_document_rules() -> None:
    model = (DOCS_ROOT / "domain-model.md").read_text(encoding="utf-8")
    data = (DOCS_ROOT / "persistence.md").read_text(encoding="utf-8")
    obsolete_handoff_type = "Handoff" + "Request"
    if obsolete_handoff_type in model or obsolete_handoff_type in data:
        fail("独立交接请求类型必须统一为 UserActionRequest")
    required_terms = [
        "MemoryCandidate",
        "replacement Job",
        "projection_checkpoint",
        "Legal Hold",
        "execution_ownership",
        "artifact_attestation",
    ]
    corpus = model + "\n" + data
    missing = [term for term in required_terms if term not in corpus]
    if missing:
        fail(f"core model missing terms: {', '.join(missing)}")


def main() -> int:
    try:
        validate_manifest()
        operations = validate_openapi()
        events = validate_events()
        errors = validate_errors()
        cases = validate_conformance()
        validate_cross_document_rules()
    except AssertionError as exc:
        print(f"Contract validation failed: {exc}", file=sys.stderr)
        return 1
    print(f"Contracts valid: {operations} operations, {events} events, {errors} errors, {cases} conformance cases")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
