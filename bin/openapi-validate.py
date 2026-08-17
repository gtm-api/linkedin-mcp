#!/usr/bin/env python3
"""Validate one generated openapi.yaml document from gtm.openapi.public.

    python3 bin/openapi-validate.py ../../openapi/gtm.openapi.public/services/linkedin

bin/openapi-public.sh runs it over every services/*/ directory once the
generator has written them; that script is the only caller.

It moved into this repo on 2026-08-16, when gtm.openapi.tech (the internal
hand-assembled spec it was originally written for) was retired. There is one
OpenAPI spec left in the house, this repo generates it, so the validator lives
with it. Python deps: bin/requirements.txt.

Gates (the Redocly/Spectral rules we cannot run without Node):
  1. Structural validity against the document's own OpenAPI version
     (openapi_spec_validator dispatches on the `openapi:` field; the generated
     documents are 3.0.3 today).
  2. Every operation: operationId (present + globally unique), summary,
     description, and at least one documented 4xx (or `4XX`) response.
  3. Every internal "#/components/..." $ref resolves.
  4. Every `type: array` schema node declares `items`.
  4b. Redocly spec-level rules: info-license-strict, no-server-example.com,
      no-ambiguous-paths, no-unused-components (warn).

Route coverage is deliberately NOT a gate here. The retired tech repo compared
each document against a `_frag/_routes.json` dump of the Laravel router. These
documents are projected from the Zod tool registry instead: the registry is
its own oracle, and tests/coverage-gate.test.ts is the gate that holds it. The
branch could never fire on a public document (it only ever printed
"_routes.json missing"), so it was dropped rather than left dormant.

Exit 0 = clean.
"""
import json
import os
import re
import sys

import yaml


def main(svc_dir: str) -> int:
    svc = os.path.abspath(svc_dir)
    spec_path = os.path.join(svc, "openapi.yaml")
    if not os.path.isfile(spec_path):
        print(f"ERROR: {spec_path} not found. Run bin/openapi-public.sh first.", file=sys.stderr)
        return 2

    doc = yaml.safe_load(open(spec_path))
    errors = []
    warnings = []

    # ---- 1. OAS structural validity ---------------------------------------
    try:
        from openapi_spec_validator import validate as oas_validate
        try:
            oas_validate(doc)
        except Exception as e:  # noqa: BLE001
            errors.append(f"[OAS] {str(e).splitlines()[0]}")
    except ImportError:
        warnings.append("openapi_spec_validator not installed, skipped structural validation")

    HTTP_METHODS = {"get", "put", "post", "delete", "options", "head", "patch", "trace"}

    # ---- 2. per-operation rules -------------------------------------------
    op_ids = {}
    for path, item in (doc.get("paths") or {}).items():
        for method, op in item.items():
            if method not in HTTP_METHODS:
                continue
            where = f"{method.upper()} {path}"
            oid = op.get("operationId")
            if not oid:
                errors.append(f"[operationId] missing: {where}")
            else:
                op_ids.setdefault(oid, []).append(where)
            if not op.get("summary"):
                errors.append(f"[summary] missing: {where}")
            if not op.get("description"):
                errors.append(f"[description] missing: {where}")
            resp = op.get("responses") or {}
            # redocly operation-4xx-response: a numeric-4xx or `4XX` is required; `default` alone does NOT satisfy it.
            if not any(str(c) == "4XX" or str(c).startswith("4") for c in resp):
                errors.append(f"[4xx] no 4xx/4XX response: {where}")
    for oid, wheres in op_ids.items():
        if len(wheres) > 1:
            errors.append(f"[operationId-unique] '{oid}' used by {wheres}")

    # ---- 3. ref resolution + 4. array items (walk whole doc) --------------
    def resolve(ref):
        if not ref.startswith("#/"):
            return True  # external refs not used
        node = doc
        for part in ref[2:].split("/"):
            part = part.replace("~1", "/").replace("~0", "~")
            if isinstance(node, dict) and part in node:
                node = node[part]
            else:
                return False
        return True

    def walk(node, p):
        if isinstance(node, dict):
            if "$ref" in node and isinstance(node["$ref"], str):
                if not resolve(node["$ref"]):
                    errors.append(f"[ref] unresolved {node['$ref']} at {p}")
            if node.get("type") == "array" and "items" not in node:
                errors.append(f"[array-items] missing items at {p}")
            # redocly nullable-type-sibling: `nullable` is meaningless in OAS 3.0 without a sibling `type`.
            if node.get("nullable") is True and "type" not in node:
                errors.append(f"[nullable-type-sibling] nullable without type at {p}")
            for k, v in node.items():
                walk(v, f"{p}/{k}")
        elif isinstance(node, list):
            for i, v in enumerate(node):
                walk(v, f"{p}[{i}]")

    walk(doc, "")

    # ---- 4b. spec-level redocly rules -------------------------------------
    # info-license-strict: license present, with url or identifier.
    lic = (doc.get("info") or {}).get("license") or {}
    if not lic:
        errors.append("[info-license-strict] info.license missing")
    elif not (lic.get("url") or lic.get("identifier")):
        errors.append("[info-license-strict] info.license needs url or identifier")
    # no-server-example.com: production servers only.
    for s in doc.get("servers") or []:
        if "example.com" in (s.get("url") or ""):
            errors.append(f"[no-server-example.com] {s.get('url')}")
    # no-ambiguous-paths: two templated paths that match the same concrete URLs.
    seen_norm = {}
    for p in (doc.get("paths") or {}):
        n = re.sub(r"\{[^}]+\}", "{}", p)
        if n in seen_norm and seen_norm[n] != p:
            errors.append(f"[no-ambiguous-paths] {seen_norm[n]} vs {p}")
        seen_norm[n] = p
    # no-unused-components: every schemas/parameters/responses component is referenced somewhere.
    blob = json.dumps(doc)
    components = (doc.get("components") or {})
    for bucket in ("schemas", "parameters", "responses"):
        referenced = set(re.findall(rf"#/components/{bucket}/([A-Za-z0-9_]+)", blob))
        for name in components.get(bucket) or {}:
            if name not in referenced:
                warnings.append(f"[no-unused-components] {bucket[:-1]} '{name}' never referenced")

    # ---- report -----------------------------------------------------------
    print(f"operations: {sum(1 for _ in op_ids)} unique operationIds")
    for w in warnings:
        print("WARN:", w)
    if errors:
        print(f"\nFAIL: {len(errors)} error(s):")
        for e in errors:
            print("  -", e)
        return 1
    print("\nOK: spec is valid and complete.")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("usage: openapi-validate.py <service-dir>", file=sys.stderr)
        sys.exit(2)
    sys.exit(main(sys.argv[1]))
