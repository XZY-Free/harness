#!/usr/bin/env python3
"""跨脚本共享的契约规则单一事实源。

`generate_openapi.py`（生成）与 `validate_contracts.py`（校验）必须在同一事实上做
判断，否则会出现"契约声明 A、门禁按 B 检查"的双轨：生成器给只读 POST 写了
`IDEMPOTENCY_CONFLICT`，校验器又把它排除在 Idempotency-Key 之外——同一个接口在
同一份产物里被两种语义描述。

只读 POST（`READ_ONLY_POSTS`）的定义是：**不创建、不变更任何平台资源**，因此没有
可幂等的副作用，声明 `Idempotency-Key` 只会让调用方误以为存在重放语义。使用 POST
而不是 GET 是为了不把短期 bearer capability 放进 URL、访问日志与代理缓存键。

这份清单是**人工评审过**的：新增条目等于声明"该接口无副作用"，两端同时生效，
并且校验器会反向核对产物里的声明确实来自本清单，防止用扩展字段静默消音门禁。
"""

from __future__ import annotations

READ_ONLY_POSTS: dict[str, str] = {
    "/gateway/context/query": "只读查询上下文，不写任何持久状态。",
    "/gateway/attachments/resolve": (
        "按短期 bearer capability 只读返回原文件字节，不创建或变更平台资源；"
        "使用 POST 是为了不把 capability 出现在 URL、访问日志和代理缓存键中。"
    ),
}
