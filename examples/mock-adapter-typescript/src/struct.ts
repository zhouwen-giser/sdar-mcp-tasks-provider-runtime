type ProtoValue =
  | { nullValue: 0 }
  | { numberValue: number }
  | { stringValue: string }
  | { boolValue: boolean }
  | { listValue: { values: ProtoValue[] } }
  | { structValue: ProtoStruct };

export interface ProtoStruct {
  fields: Record<string, ProtoValue>;
}

function toValue(value: unknown): ProtoValue {
  if (value === null) return { nullValue: 0 };
  if (typeof value === "number") return { numberValue: value };
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { boolValue: value };
  if (Array.isArray(value)) return { listValue: { values: value.map(toValue) } };
  if (typeof value === "object")
    return { structValue: jsonToStruct(value as Record<string, unknown>) };
  throw new TypeError(`Unsupported protobuf Struct value: ${typeof value}`);
}

export function jsonToStruct(value: Record<string, unknown>): ProtoStruct {
  return {
    fields: Object.fromEntries(Object.entries(value).map(([key, item]) => [key, toValue(item)])),
  };
}
