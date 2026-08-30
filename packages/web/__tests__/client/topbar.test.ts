import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

let mockLocation = { pathname: "/runs" };
let mockToken: string | null = null;
let mockHealthData: { credential: "valid" | "invalid" | "not-configured"; provider?: "available" | "unavailable" } | undefined = undefined;

vi.mock("react-router", () => ({
  useLocation: () => mockLocation,
}));

vi.mock("../../src/client/hooks/use-session-token.js", () => ({
  useSessionToken: () => ({
    token: mockToken,
    setToken: vi.fn(),
  }),
}));

vi.mock("../../src/client/hooks/use-query.js", () => ({
  useQuery: () => ({
    data: mockHealthData,
    loading: false,
    error: null,
    refetch: vi.fn(),
  }),
}));

import { TopBar } from "../../src/client/layouts/TopBar.js";

describe("TopBar credential status (SUG-2)", () => {
  it("renders not-configured state when token is null", () => {
    mockToken = null;
    mockHealthData = undefined;

    const html = renderToStaticMarkup(React.createElement(TopBar, {}));
    expect(html).toContain("aria-label=\"连接凭据：未配置\"");
    expect(html).toContain("未配置凭据");
  });

  it("renders checking state when token is present but health has not resolved yet", () => {
    mockToken = "session-tok-123";
    mockHealthData = undefined;

    const html = renderToStaticMarkup(React.createElement(TopBar, {}));
    expect(html).toContain("aria-label=\"连接凭据：校验中\"");
    expect(html).toContain("校验中");
    expect(html).toContain("status-dot-checking");
  });

  it("renders valid state when healthData.credential is valid", () => {
    mockToken = "session-tok-123";
    mockHealthData = { credential: "valid" };

    const html = renderToStaticMarkup(React.createElement(TopBar, {}));
    expect(html).toContain("aria-label=\"连接凭据：有效\"");
    expect(html).toContain("凭据有效");
    expect(html).toContain("status-dot-connected");
  });

  it("renders invalid state when healthData.credential is invalid", () => {
    mockToken = "session-tok-123";
    mockHealthData = { credential: "invalid" };

    const html = renderToStaticMarkup(React.createElement(TopBar, {}));
    expect(html).toContain("aria-label=\"连接凭据：无效\"");
    expect(html).toContain("凭据无效");
    expect(html).toContain("status-dot-disconnected");
  });
});
