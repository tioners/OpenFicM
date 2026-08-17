from __future__ import annotations

from typing import Any


def inline_local_schema_references(
    schema: Any,
    definitions: dict[str, Any],
    resolving: frozenset[str] = frozenset(),
) -> Any:
    if isinstance(schema, list):
        return [inline_local_schema_references(item, definitions, resolving) for item in schema]
    if not isinstance(schema, dict):
        return schema

    reference = schema.get("$ref")
    if isinstance(reference, str) and reference.startswith("#/$defs/"):
        definition_name = reference.removeprefix("#/$defs/")
        definition = definitions.get(definition_name)
        if isinstance(definition, dict) and definition_name not in resolving:
            resolved_definition = inline_local_schema_references(
                definition,
                definitions,
                resolving | {definition_name},
            )
            sibling_fields = {
                key: inline_local_schema_references(value, definitions, resolving)
                for key, value in schema.items()
                if key != "$ref"
            }
            return {**resolved_definition, **sibling_fields}

    return {
        key: inline_local_schema_references(value, definitions, resolving)
        for key, value in schema.items()
        if key != "$defs"
    }


def collapse_nullable_unions(schema: Any) -> Any:
    if isinstance(schema, list):
        return [collapse_nullable_unions(item) for item in schema]
    if not isinstance(schema, dict):
        return schema

    normalized = {key: collapse_nullable_unions(value) for key, value in schema.items()}
    alternatives = normalized.get("anyOf")
    if isinstance(alternatives, list) and len(alternatives) == 2:
        non_null = [item for item in alternatives if not (isinstance(item, dict) and item.get("type") == "null")]
        has_null = any(isinstance(item, dict) and item.get("type") == "null" for item in alternatives)
        if has_null and len(non_null) == 1 and isinstance(non_null[0], dict):
            collapsed = {**non_null[0], **{key: value for key, value in normalized.items() if key != "anyOf"}}
            collapsed["nullable"] = True
            return collapsed
    if isinstance(alternatives, list) and len(alternatives) > 1:
        primitive_types = {
            item.get("type")
            for item in alternatives
            if isinstance(item, dict) and isinstance(item.get("type"), str)
        }
        if len(primitive_types) == len(alternatives) and primitive_types <= {"string", "integer", "number", "boolean"}:
            collapsed = {key: value for key, value in normalized.items() if key != "anyOf"}
            collapsed["type"] = (
                "string"
                if "string" in primitive_types
                else "number"
                if "number" in primitive_types
                else "integer"
            )
            return collapsed
    return normalized
