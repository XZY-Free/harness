#!/usr/bin/env python3
"""Generate and verify the SnowHarness OpenAPI contract from normative API documents."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[3]
DOCS_ROOT = REPO_ROOT / "docs" / "architecture"
CONTRACTS_ROOT = REPO_ROOT / "docs" / "contracts"
CONTRACT_PATH = CONTRACTS_ROOT / "openapi.json"
ERROR_CATALOG_PATH = CONTRACTS_ROOT / "error-codes.json"
MANIFEST_PATH = CONTRACTS_ROOT / "contract-manifest.json"
DOC_GLOBS = (
    "api-and-events.md",
    "capability-and-collaboration-api.md",
    "memory-and-job-api.md",
    "security.md",
)
HTTP_LINE = re.compile(r"^`(GET|POST|PUT|PATCH|DELETE) ([^`]+)`$")
HEADING = re.compile(r"^###\s+(.+)$")
SEMVER_RE = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+$")


def load_api_version() -> str:
    """读取 OpenAPI API 版本的唯一来源：contract-manifest.json 顶层 api_version。

    缺失、非字符串或非法 SemVer（x.y.z）时 fail-closed，绝不回退到任何
    硬编码版本，避免生成产物与唯一来源脱钩。
    """
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    version = manifest.get("api_version")
    if not isinstance(version, str) or not version.strip():
        raise SystemExit(
            "contract-manifest.json 缺少顶层 api_version；"
            "OpenAPI info.version 必须来自该单一来源"
        )
    version = version.strip()
    if not SEMVER_RE.match(version):
        raise SystemExit(
            f"contract-manifest.json api_version 必须是 x.y.z SemVer，得到：{version!r}"
        )
    return version


def slug(text: str) -> str:
    text = re.sub(r"^\d+(?:\.\d+)*\s+", "", text).strip().lower()
    text = re.sub(r"[^a-z0-9\u4e00-\u9fff]+", "-", text).strip("-")
    return text or "operation"


def operation_id(method: str, path: str) -> str:
    value = path.strip("/").replace(":", "/")
    value = re.sub(r"\{([^}]+)\}", r"by_\1", value)
    value = re.sub(r"[^A-Za-z0-9]+", "_", value).strip("_")
    return f"{method.lower()}_{value}"


def scalar_schema(type_name: str) -> dict[str, Any]:
    normalized = type_name.strip().lower().replace(" ", "")
    nullable = "/null" in normalized or "null" in normalized
    normalized = normalized.replace("/null", "").replace("null", "")
    if normalized == "array":
        schema: dict[str, Any] = {"type": "array", "items": {}}
    elif normalized.endswith("[]"):
        schema: dict[str, Any] = {
            "type": "array",
            "items": scalar_schema(normalized[:-2] or "string"),
        }
    elif normalized in {"object", "json"}:
        schema = {"type": "object", "additionalProperties": True}
    elif normalized in {"integer", "int", "bigint"}:
        schema = {"type": "integer"}
    elif normalized in {"number", "decimal"}:
        schema = {"type": "number"}
    elif normalized in {"boolean", "bool"}:
        schema = {"type": "boolean"}
    elif normalized == "binary":
        schema = {"type": "string", "format": "binary"}
    else:
        schema = {"type": "string"}
    if nullable:
        schema = {"anyOf": [schema, {"type": "null"}]}
    return schema


def infer_schema(value: Any) -> dict[str, Any]:
    if value is None:
        return {"type": "null"}
    if isinstance(value, bool):
        return {"type": "boolean"}
    if isinstance(value, int):
        return {"type": "integer"}
    if isinstance(value, float):
        return {"type": "number"}
    if isinstance(value, str):
        return {"type": "string"}
    if isinstance(value, list):
        schemas = [infer_schema(item) for item in value]
        unique_schemas: list[dict[str, Any]] = []
        seen: set[str] = set()
        for schema in schemas:
            key = json.dumps(schema, sort_keys=True, ensure_ascii=False)
            if key not in seen:
                seen.add(key)
                unique_schemas.append(schema)
        if not unique_schemas:
            item_schema = {}
        elif len(unique_schemas) == 1:
            item_schema = unique_schemas[0]
        else:
            item_schema = {"oneOf": unique_schemas}
        return {"type": "array", "items": item_schema}
    if isinstance(value, dict):
        return {
            "type": "object",
            "properties": {key: infer_schema(item) for key, item in value.items()},
            "required": list(value.keys()),
            "additionalProperties": False,
        }
    return {}


def parse_json_response(section: list[str]) -> tuple[dict[str, Any], Any | None]:
    in_curl = False
    curl_seen = False
    in_json = False
    payload: list[str] = []
    for line in section:
        if line == "```bash":
            in_curl = True
            continue
        if in_curl and line == "```":
            in_curl = False
            curl_seen = True
            continue
        if curl_seen and line == "```json":
            in_json = True
            continue
        if in_json and line == "```":
            try:
                example = json.loads("\n".join(payload))
                return infer_schema(example), example
            except json.JSONDecodeError:
                return {"type": "string"}, None
        if in_json:
            payload.append(line)
    return {"type": "object", "additionalProperties": True}, None


def parse_parameters(section: list[str]) -> tuple[list[dict[str, Any]], dict[str, Any] | None]:
    parameters: list[dict[str, Any]] = []
    body_properties: dict[str, Any] = {}
    body_required: list[str] = []
    form_properties: dict[str, Any] = {}
    form_required: list[str] = []
    table_started = False
    for line in section:
        if line.startswith("| 请求参数 |"):
            table_started = True
            continue
        if not table_started:
            continue
        if line.startswith("|---"):
            continue
        if not line.startswith("|"):
            if body_properties or parameters:
                break
            continue
        cells = [cell.strip().strip("`") for cell in line.strip().strip("|").split("|")]
        if len(cells) < 5:
            continue
        name, location, type_name, required, description = cells[:5]
        location_lower = location.lower()
        is_required = required == "是"
        schema = scalar_schema(type_name)
        if location_lower == "body":
            body_properties[name] = schema | {"description": description}
            if is_required:
                body_required.append(name)
        elif location_lower == "form":
            form_properties[name] = schema | {"description": description}
            if is_required:
                form_required.append(name)
        elif location_lower in {"path", "query", "header", "cookie"}:
            parameters.append(
                {
                    "name": name,
                    "in": location_lower,
                    "required": True if location_lower == "path" else is_required,
                    "description": description,
                    "schema": schema,
                }
            )
    request_body = None
    if body_properties:
        request_body = {
            "required": bool(body_required),
            "content": {
                "application/json": {
                    "schema": {
                        "type": "object",
                        "properties": body_properties,
                        "required": body_required,
                        "additionalProperties": False,
                    }
                }
            },
        }
    elif form_properties:
        request_body = {
            "required": bool(form_required),
            "content": {
                "multipart/form-data": {
                    "schema": {
                        "type": "object",
                        "properties": form_properties,
                        "required": form_required,
                        "additionalProperties": False,
                    }
                }
            },
        }
    return parameters, request_body


def security_for(path: str) -> list[dict[str, list[str]]]:
    if path.endswith("/auth/callback"):
        return [{"employeeSession": []}]
    if path.startswith("/api/"):
        return [{"employeeAuth": []}]
    if path.startswith("/runtime/"):
        return [{"runtimeAuth": []}]
    if path.startswith("/gateway/"):
        return [{"workloadAuth": []}]
    return [{"adminAuth": []}]


def boundary_for(path: str) -> str:
    if path.startswith("/api/"):
        return "employee"
    if path.startswith("/runtime/"):
        return "runtime"
    if path.startswith("/gateway/"):
        return "gateway"
    return "admin"


def success_status(method: str, path: str, section: list[str]) -> str:
    text = "\n".join(section)
    explicit = re.search(r"返回\s+`?(20[012])`?", text)
    if explicit:
        return explicit.group(1)
    if method == "GET":
        return "200"
    status_overrides = {
        "/api/v1/threads/{thread_id}/change-primary-agent": "200",
        "/api/v1/turns/{turn_id}/steer": "202",
        "/api/v1/turns/{turn_id}/interrupt": "202",
        "/api/v1/turns/{turn_id}/regenerate": "202",
        "/api/v1/threads/{thread_id}/pending-inputs/reorder": "200",
        "/api/v1/user-action-requests/{request_id}/resolve": "202",
        "/runtime/v1/invocations": "202",
        "/runtime/v1/invocations/{invocation_id}/events/batch": "202",
        "/runtime/v1/invocations/{invocation_id}/transient-events/batch": "202",
        "/runtime/v1/invocations/{invocation_id}/cancel": "202",
        "/runtime/v1/invocations/{invocation_id}/resume": "202",
        "/runtime/v1/invocations/{invocation_id}/steer": "202",
        "/gateway/v1/tool-calls/{tool_call_id}/reconcile-effect": "200",
        "/gateway/v1/context/query": "200",
        "/admin/api/v1/agent-revisions/{revision_id}/publish": "200",
        "/admin/api/v1/tool-calls/{tool_call_id}/reconcile-effect": "200",
        "/admin/api/v1/jobs/{job_id}/publish-to-thread": "201",
        "/gateway/v1/capabilities/search": "200",
        "/gateway/v1/child-threads/{child_thread_id}/cancel": "202",
        "/admin/api/v1/memory-candidates/{candidate_id}/resolve": "200",
        "/admin/api/v1/jobs/{job_id}/cancel": "202",
        "/admin/api/v1/jobs/{job_id}/retry": "201",
        "/admin/api/v1/event-quarantines/{failure_id}/resolve": "202",
        "/api/v1/threads/{thread_id}/request-execution-environment-change": "202",
        "/admin/api/v1/artifact-attestations/verify": "200",
        "/admin/api/v1/legal-holds/release": "200",
    }
    if path in status_overrides:
        return status_overrides[path]
    if method == "POST" and ":" not in path and path.rstrip("/").split("/")[-1] in {
        "threads", "turns", "pending-inputs", "attachments", "workspace-attachments", "artifacts", "revisions",
        "forks", "user-action-requests", "child-threads", "memory-candidates", "context-checkpoints",
        "legal-holds", "deletion-requests",
    }:
        return "201"
    if method == "POST" and ":" in path:
        return "202"
    return "200"


def add_conditional_request_rules(path: str, request_body: dict[str, Any]) -> None:
    media_types = request_body.get("content", {})
    json_media = media_types.get("application/json")
    if not json_media:
        return
    schema = json_media["schema"]
    rules: dict[str, list[dict[str, Any]]] = {
        "/gateway/v1/user-action-requests": [
            {
                "if": {"properties": {"request_type": {"const": "input"}}, "required": ["request_type"]},
                "then": {"properties": {"input_schema": {}}, "required": ["input_schema"]},
            }
        ],
        "/admin/api/v1/tool-calls/{tool_call_id}/reconcile-effect": [
            {
                "if": {
                    "properties": {
                        "verification_mode": {"enum": ["callback_evidence", "manual_evidence"]}
                    },
                    "required": ["verification_mode"],
                },
                "then": {"properties": {"evidence_ref": {}}, "required": ["evidence_ref"]},
            }
        ],
        "/admin/api/v1/jobs/{job_id}/publish-to-thread": [
            {
                "if": {
                    "properties": {"publish_mode": {"const": "existing_source_turn"}},
                    "required": ["publish_mode"],
                },
                "then": {"properties": {"source_turn_id": {}}, "required": ["source_turn_id"]},
            }
        ],
    }
    if path in rules:
        schema["allOf"] = rules[path]


def iter_operations() -> list[dict[str, Any]]:
    operations: list[dict[str, Any]] = []
    known_errors = set(json.loads(ERROR_CATALOG_PATH.read_text(encoding="utf-8"))["errors"])
    for name in DOC_GLOBS:
        path = DOCS_ROOT / name
        lines = path.read_text(encoding="utf-8").splitlines()
        heading = ""
        index = 0
        while index < len(lines):
            heading_match = HEADING.match(lines[index])
            if heading_match:
                heading = heading_match.group(1)
            http_match = HTTP_LINE.match(lines[index])
            if not http_match:
                index += 1
                continue
            method, route = http_match.groups()
            external_runtime_endpoint = route.startswith("{runtime_endpoint}")
            route = route.replace("{runtime_endpoint}", "")
            if not route.startswith("/"):
                raise ValueError(f"OpenAPI path must start with '/': {route}")
            end = index + 1
            while end < len(lines) and not HEADING.match(lines[end]):
                end += 1
            section = lines[index + 1 : end]
            is_sse = method == "GET" and route.endswith("/events")
            if not any(line.startswith("| 请求参数 |") for line in section):
                raise ValueError(f"API section missing request parameter table: {name} {heading}")
            if "```bash" not in section:
                raise ValueError(f"API section missing curl example: {name} {heading}")
            if "```json" not in section and not is_sse:
                raise ValueError(f"API section missing JSON response example: {name} {heading}")
            parameters, request_body = parse_parameters(section)
            response_schema, response_example = parse_json_response(section)
            operations.append(
                {
                    "method": method,
                    "path": route,
                    "heading": heading,
                    "doc": name,
                    "anchor": slug(heading),
                    "parameters": parameters,
                    "request_body": request_body,
                    "response_schema": response_schema,
                    "response_example": response_example,
                    "success_status": success_status(method, route, section),
                    "external_runtime_endpoint": external_runtime_endpoint,
                    "error_codes": sorted(
                        set(re.findall(r"\b[A-Z][A-Z0-9_]{3,}\b", "\n".join(section)))
                        & known_errors
                    ),
                }
            )
            index = end
    return operations


def build_contract() -> dict[str, Any]:
    operations = iter_operations()
    paths: dict[str, Any] = {}
    seen_operation_ids: set[str] = set()
    for item in operations:
        op_id = operation_id(item["method"], item["path"])
        if op_id in seen_operation_ids:
            raise ValueError(f"duplicate operationId: {op_id}")
        seen_operation_ids.add(op_id)
        is_event_stream = item["method"] == "GET" and item["path"].endswith("/events")
        media: dict[str, Any] = {
            "schema": {"type": "string"} if is_event_stream else item["response_schema"]
        }
        if item["response_example"] is not None:
            media["example"] = item["response_example"]
        operation: dict[str, Any] = {
            "operationId": op_id,
            "summary": re.sub(r"^\d+(?:\.\d+)*\s+", "", item["heading"]),
            "tags": [boundary_for(item["path"])],
            "security": security_for(item["path"]),
            "parameters": item["parameters"],
            "responses": {
                item["success_status"]: {
                    "description": "成功响应，字段语义以对应规范章节为准。",
                    "content": {"text/event-stream" if is_event_stream else "application/json": media},
                },
                "default": {"$ref": "#/components/responses/ErrorResponse"},
            },
            "x-snowharness-doc": f"{item['doc']}#{item['anchor']}",
            "x-snowharness-boundary": boundary_for(item["path"]),
        }
        common_errors = {
            "AUTHENTICATION_REQUIRED",
            "ACCESS_DENIED",
            "REQUEST_SCHEMA_INVALID",
            "RESOURCE_NOT_FOUND",
            "RATE_LIMITED",
        }
        if item["method"] == "POST" and item["path"] != "/gateway/v1/context/query":
            common_errors.add("IDEMPOTENCY_CONFLICT")
        if item["method"] in {"PUT", "PATCH"}:
            common_errors.add("ETAG_MISMATCH")
        operation["x-snowharness-error-codes"] = sorted(common_errors | set(item["error_codes"]))
        if item["request_body"]:
            operation["requestBody"] = item["request_body"]
            add_conditional_request_rules(item["path"], operation["requestBody"])
        if is_event_stream:
            operation["x-snowharness-event-envelope-schema"] = "./event-envelope.schema.json"
        if item["external_runtime_endpoint"]:
            operation["servers"] = [
                {
                    "url": "{runtime_endpoint}",
                    "description": "DeploymentRoute 绑定的受管 Runtime endpoint",
                    "variables": {
                        "runtime_endpoint": {
                            "default": "https://runtime.example.com",
                            "description": "不得包含 Credential 的受管 endpoint",
                        }
                    },
                }
            ]
        paths.setdefault(item["path"], {})[item["method"].lower()] = operation
    return {
        "openapi": "3.1.0",
        "info": {
            "title": "SnowHarness API",
            "version": load_api_version(),
            "description": "由 规范文档生成。文档参数表和示例是生成输入，生成文件禁止手改。",
        },
        "servers": [
            {
                "url": "https://{snow_host}",
                "variables": {
                    "snow_host": {
                        "default": "snow.company.internal",
                        "description": "SnowHarness API host",
                    }
                },
            }
        ],
        "tags": [
            {"name": "employee", "description": "Desktop/Web 员工交互"},
            {"name": "runtime", "description": "Runtime Adapter 协议"},
            {"name": "gateway", "description": "Invocation-scoped 内部网关"},
            {"name": "admin", "description": "管理与运维"},
        ],
        "paths": paths,
        "components": {
            "securitySchemes": {
                "employeeAuth": {"type": "http", "scheme": "bearer"},
                "employeeSession": {"type": "apiKey", "in": "cookie", "name": "snow_session"},
                "runtimeAuth": {"type": "http", "scheme": "bearer"},
                "workloadAuth": {"type": "http", "scheme": "bearer"},
                "adminAuth": {"type": "http", "scheme": "bearer"},
            },
            "schemas": {
                "Error": {
                    "type": "object",
                    "required": ["error"],
                    "properties": {
                        "error": {
                            "type": "object",
                            "required": ["code", "message", "request_id", "retryable"],
                            "properties": {
                                "code": {"type": "string"},
                                "message": {"type": "string"},
                                "request_id": {"type": "string"},
                                "retryable": {"type": "boolean"},
                                "details": {"type": "object", "additionalProperties": True},
                            },
                            "additionalProperties": False,
                        }
                    },
                    "additionalProperties": False,
                }
            },
            "responses": {
                "ErrorResponse": {
                    "description": "稳定错误响应；code 必须存在于 error-codes.json。",
                    "content": {
                        "application/json": {"schema": {"$ref": "#/components/schemas/Error"}}
                    },
                }
            },
        },
        "x-snowharness-operation-count": len(operations),
    }


def rendered_contract() -> str:
    return json.dumps(build_contract(), ensure_ascii=False, indent=2, sort_keys=False) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser()
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--write", action="store_true", help="write the generated contract")
    group.add_argument("--check", action="store_true", help="verify the generated contract is current")
    args = parser.parse_args()
    rendered = rendered_contract()
    if args.write:
        CONTRACT_PATH.parent.mkdir(parents=True, exist_ok=True)
        CONTRACT_PATH.write_text(rendered, encoding="utf-8")
        print(f"wrote {CONTRACT_PATH.relative_to(REPO_ROOT)}")
        return 0
    if not CONTRACT_PATH.exists():
        print(f"missing {CONTRACT_PATH.relative_to(REPO_ROOT)}", file=sys.stderr)
        return 1
    actual = CONTRACT_PATH.read_text(encoding="utf-8")
    if actual != rendered:
        print("OpenAPI contract is stale; run generate_openapi.py --write", file=sys.stderr)
        return 1
    contract = json.loads(actual)
    print(f"OpenAPI current: {contract['x-snowharness-operation-count']} operations")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
