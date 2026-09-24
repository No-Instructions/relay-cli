import { addExtension, Encoder } from "cbor-x";

// Persist a versioned wire format shared by Node and Bun.
const MAGIC = Buffer.from("RMD-IDB-CBOR-1\0");
const codec = new Encoder({ structuredClone: true, useRecords: false, alwaysUseFloat: true });

// CBOR's default byte string does not distinguish ArrayBuffer from Uint8Array.
addExtension({
  Class: ArrayBuffer, tag: 60000,
  encode(value: ArrayBuffer, encode: (value: unknown) => void) { encode(new Uint8Array(value)); },
  decode(value: Uint8Array) { return Uint8Array.from(value).buffer; },
});
addExtension({
  Class: DataView, tag: 60001,
  encode(value: DataView, encode: (value: unknown) => void) { encode(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)); },
  decode(value: Uint8Array) { return new DataView(Uint8Array.from(value).buffer); },
});

export function serializeRecord(value: unknown): Buffer {
  return Buffer.concat([MAGIC, codec.encode(value)]);
}

export function deserializeRecord(value: Uint8Array): unknown {
  if (!Buffer.from(value).subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error("Unsupported IndexedDB record format.");
  }
  return codec.decode(value.subarray(MAGIC.length));
}
