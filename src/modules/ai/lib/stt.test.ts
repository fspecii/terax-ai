import { describe, expect, it } from "vitest";
import { assertLoopbackUrl, buildMultipartBody } from "./stt";

describe("assertLoopbackUrl", () => {
  it.each([
    "http://localhost:8080",
    "http://127.0.0.1:8000",
    "http://127.1.2.3:9000/v1",
    "http://[::1]:8000",
  ])("accepts loopback %s", (url) => {
    expect(() => assertLoopbackUrl(url, "Parakeet")).not.toThrow();
  });

  it.each([
    "http://192.168.1.10:8000",
    "http://example.com",
    "https://api.openai.com/v1",
    "http://localhost.evil.com:8000",
    "http://127.0.0.1.evil.com:8000",
    "http://[::2]:8000",
    "http://0.0.0.0:8000",
  ])("rejects non-loopback %s", (url) => {
    expect(() => assertLoopbackUrl(url, "Parakeet")).toThrow(/loopback/);
  });

  it("rejects unparseable URLs", () => {
    expect(() => assertLoopbackUrl("not a url", "Parakeet")).toThrow(
      /Invalid Parakeet URL/,
    );
  });

  it("names the provider in the error", () => {
    expect(() => assertLoopbackUrl("http://example.com", "Whisper.cpp")).toThrow(
      /Whisper\.cpp/,
    );
  });
});

describe("buildMultipartBody", () => {
  it("produces a body FormData parsers accept, with binary bytes intact", async () => {
    const bytes = new Uint8Array([0, 1, 2, 255, 254, 128, 13, 10, 0]);
    const boundary = "----terax-test";
    const body = buildMultipartBody(
      [
        { name: "file", filename: "a.wav", contentType: "audio/wav", bytes },
        { name: "response_format", value: "text" },
        { name: "model", value: "mlx-community/parakeet-tdt-0.6b-v3" },
      ],
      boundary,
    );

    const res = new Response(body, {
      headers: {
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
    });
    const form = await res.formData();
    const file = form.get("file") as File;
    expect(file.name).toBe("a.wav");
    expect(file.type).toBe("audio/wav");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes);
    expect(form.get("response_format")).toBe("text");
    expect(form.get("model")).toBe("mlx-community/parakeet-tdt-0.6b-v3");
  });

  it("terminates with the closing boundary", () => {
    const body = buildMultipartBody(
      [{ name: "a", value: "b" }],
      "----terax-test",
    );
    const text = new TextDecoder().decode(body);
    expect(text.endsWith("------terax-test--\r\n")).toBe(true);
  });
});
