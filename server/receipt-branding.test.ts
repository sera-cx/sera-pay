import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getReceiptInitial, getReceiptLogo, prepareReceiptLogo } from "../client/src/lib/receipt-branding";
import { ReceiptMerchantLogo } from "../client/src/components/ReceiptMerchantLogo";

let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  if (renderer) await act(async () => renderer!.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe("receipt branding", () => {
  it("uses the same single uppercase initial for lowercase, spaced, and missing names", () => {
    expect(getReceiptInitial("  charles store ")).toBe("C");
    expect(getReceiptInitial("c")).toBe("C");
    expect(getReceiptInitial("  ")).toBe("S");
    expect(getReceiptInitial(null)).toBe("S");
  });

  it("refreshes the saved logo for a direct-payment recipient before export", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ logoData: "/api/storage/objects/merchant-logos/test/logo" }) });
    vi.stubGlobal("fetch", fetchMock);
    const recipient = "0x1234567890abcdef1234567890abcdef12345678";
    expect(await getReceiptLogo(recipient, "")).toBe("/api/storage/objects/merchant-logos/test/logo");
    expect(fetchMock).toHaveBeenCalledWith(`/api/merchant/public/${recipient}`, { cache: "no-store" });
  });

  it("honors a removed logo and preserves the known logo if the refresh fails", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ logoData: null }) })
      .mockResolvedValueOnce({ ok: false })
      .mockRejectedValueOnce(new Error("offline"));
    vi.stubGlobal("fetch", fetchMock);
    expect(await getReceiptLogo("recipient", "old-logo")).toBe("");
    expect(await getReceiptLogo("recipient", "saved-logo")).toBe("saved-logo");
    expect(await getReceiptLogo("recipient", "saved-logo")).toBe("saved-logo");
    expect(await getReceiptLogo(undefined, "saved-logo")).toBe("saved-logo");
  });

  it("decodes uploads to PNG and fits a rectangular logo without distortion", async () => {
    const drawImage = vi.fn();
    const toDataURL = vi.fn().mockReturnValue("data:image/png;base64,test-image");
    vi.stubGlobal("Image", class {
      crossOrigin = "";
      naturalWidth = 800;
      naturalHeight = 400;
      onload?: () => void;
      set src(_source: string) { expect(this.crossOrigin).toBe("anonymous"); this.onload?.(); }
    });
    vi.stubGlobal("document", { createElement: () => ({ getContext: () => ({ drawImage }), toDataURL }) });
    expect(await prepareReceiptLogo("data:image/webp;base64/upload")).toBe("data:image/png;base64,test-image");
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 80, 320, 160);
    expect(toDataURL).toHaveBeenCalledWith("image/png");
  });

  it("falls back safely for missing or unreadable logos", async () => {
    vi.stubGlobal("Image", class {
      onerror?: () => void;
      set src(_source: string) { this.onerror?.(); }
    });
    expect(await prepareReceiptLogo("")).toBeNull();
    expect(await prepareReceiptLogo("broken-logo")).toBeNull();
  });

  it("shares a static white, green-ring fallback across previews and receipt pages", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("React", React);
    await act(async () => { renderer = create(React.createElement(ReceiptMerchantLogo, { name: "c", size: 38 })); });
    const frame = renderer!.root.findByType("div");
    expect(frame.children).toEqual(["C"]);
    expect(frame.props.style).toMatchObject({ background: "#fff", border: "2px solid #00D1A0", borderRadius: "50%", color: "#00D1A0" });
    await act(async () => renderer!.update(React.createElement(ReceiptMerchantLogo, { name: "c", logo: "uploaded-logo" })));
    expect(renderer!.root.findByType("img").props.src).toBe("uploaded-logo");
    await act(async () => renderer!.root.findByType("img").props.onError());
    expect(renderer!.root.findByType("div").children).toEqual(["C"]);
    await act(async () => renderer!.update(React.createElement(ReceiptMerchantLogo, { name: "c", logo: "new-logo" })));
    expect(renderer!.root.findByType("img").props.src).toBe("new-logo");
  });
});
