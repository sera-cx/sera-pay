import { PassThrough, Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { storageRead } from "./storage";

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("./_core/env", () => ({ ENV: {
  r2Endpoint: "https://storage.example.com", r2AccessKeyId: "test", r2SecretAccessKey: "test",
  r2Bucket: "test", r2PublicUrl: "",
} }));
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class { send = send; },
  GetObjectCommand: class { constructor(readonly input: unknown) {} },
}));

beforeEach(() => send.mockReset());

describe("bounded storage reads", () => {
  it("reads streamed images and passes cancellation to the storage request", async () => {
    const signal = new AbortController().signal;
    send.mockResolvedValue({ Body: Readable.from([Buffer.from("im"), Buffer.from("age")]), ContentType: "image/png" });
    await expect(storageRead("logo", { signal, maxBytes: 5 })).resolves.toEqual({
      key: "logo", body: Buffer.from("image"), contentType: "image/png",
    });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ input: { Bucket: "test", Key: "logo" } }), { abortSignal: signal });
  });

  it("stops reading and closes a stream as soon as the byte limit is exceeded", async () => {
    const body = Readable.from([Buffer.alloc(6), Buffer.alloc(6)]);
    send.mockResolvedValue({ Body: body });
    await expect(storageRead("logo", { maxBytes: 5 })).rejects.toThrow("too large");
    expect(body.destroyed).toBe(true);
  });

  it("aborts and closes a stream that stops sending data", async () => {
    const controller = new AbortController();
    const body = new PassThrough();
    send.mockResolvedValue({ Body: body });
    const result = expect(storageRead("logo", { signal: controller.signal })).rejects.toThrow("cancelled");
    await new Promise<void>(resolve => setImmediate(resolve));
    controller.abort(new Error("cancelled"));
    await result;
    expect(body.destroyed).toBe(true);
  });

  it("closes a response received after cancellation", async () => {
    const controller = new AbortController();
    const body = new PassThrough();
    send.mockResolvedValue({ Body: body });
    controller.abort(new Error("cancelled"));
    await expect(storageRead("logo", { signal: controller.signal })).rejects.toThrow("cancelled");
    expect(body.destroyed).toBe(true);
  });
});
