// @vitest-environment jsdom

import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuditFeed } from "../app/(dashboard)/keys/audit/audit-feed";
import { AuditDrawerButton } from "../components/keys/audit-drawer-button";

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe("AuditFeed", () => {
	it("renders rotated and SSO events with their canonical labels and styles", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: true,
				json: async () => ({
					events: [
						{
							id: "rotated",
							event_type: "rotated",
							details: {},
							created_at: "2026-07-29T00:00:00Z",
						},
						{
							id: "sso-issued",
							event_type: "sso_issued",
							details: {},
							created_at: "2026-07-29T00:00:00Z",
						},
					],
					next_cursor: null,
				}),
			}),
		);

		render(<AuditFeed />);

		const rotatedBadge = (
			await screen.findByRole("cell", { name: "Rotated" })
		).querySelector("span");
		const ssoBadge = screen
			.getByRole("cell", { name: "SSO issued" })
			.querySelector("span");
		expect(rotatedBadge?.className).toContain("text-sky-300");
		expect(ssoBadge?.className).toContain("text-violet-300");
	});

	it("keeps unknown future events visible with a safe fallback badge", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: true,
				json: async () => ({
					events: [
						{
							id: "future",
							event_type: "future_event",
							details: {},
							created_at: "2026-07-29T00:00:00Z",
						},
					],
					next_cursor: null,
				}),
			}),
		);

		render(<AuditFeed />);

		const badge = (
			await screen.findByRole("cell", { name: "future_event" })
		).querySelector("span");
		expect(badge).not.toBeNull();
		expect(badge?.className).toContain("bg-neutral-500/[0.12]");
		expect(badge?.className).toContain("text-neutral-300");
	});

	it("keeps prototype-key events as literal labels with a neutral badge", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: true,
				json: async () => ({
					events: [
						{
							id: "prototype-key",
							event_type: "constructor",
							details: {},
							created_at: "2026-07-29T00:00:00Z",
						},
					],
					next_cursor: null,
				}),
			}),
		);

		render(<AuditFeed />);

		const badge = await screen.findByRole("cell", { name: "constructor" });
		expect(badge.textContent).toBe("constructor");
		expect(badge.querySelector("span")?.className).toContain(
			"bg-neutral-500/[0.12]",
		);
	});

	it("resets the applied query without replaying stale filters", async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ events: [], next_cursor: null }),
		});
		vi.stubGlobal("fetch", fetchMock);

		render(<AuditFeed />);
		await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

		fireEvent.change(screen.getByLabelText("Key prefix"), {
			target: { value: "rs_live_test" },
		});
		screen.getByRole("button", { name: "Apply" }).click();

		await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
		expect(fetchMock.mock.calls[1]?.[0]).toBe(
			"/api/keys/audit?limit=50&key_prefix=rs_live_test",
		);

		screen.getByRole("button", { name: "Reset" }).click();

		await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
		expect(
			(screen.getByLabelText("Key prefix") as HTMLInputElement).value,
		).toBe("");
		expect(fetchMock.mock.calls[2]?.[0]).toBe("/api/keys/audit?limit=50");
	});

	it("ignores a filtered response that arrives after a reset response", async () => {
		type AuditResponse = {
			ok: true;
			json: () => Promise<{
				events: Array<{
					id: string;
					event_type: string;
					key_prefix: string;
					details: Record<string, never>;
					created_at: string;
				}>;
				next_cursor: null;
			}>;
		};

		const response = (id: string, keyPrefix: string): AuditResponse => ({
			ok: true,
			json: async () => ({
				events: [
					{
						id,
						event_type: "created",
						key_prefix: keyPrefix,
						details: {},
						created_at: "2026-07-29T00:00:00Z",
					},
				],
				next_cursor: null,
			}),
		});
		let resolveFiltered: (value: AuditResponse) => void = () => undefined;
		let resolveReset: (value: AuditResponse) => void = () => undefined;
		const filteredRequest = new Promise<AuditResponse>((resolve) => {
			resolveFiltered = resolve;
		});
		const resetRequest = new Promise<AuditResponse>((resolve) => {
			resolveReset = resolve;
		});
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(response("initial", "initial"))
			.mockReturnValueOnce(filteredRequest)
			.mockReturnValueOnce(resetRequest);
		vi.stubGlobal("fetch", fetchMock);

		render(<AuditFeed />);
		await screen.findByText("initial…");

		fireEvent.change(screen.getByLabelText("Key prefix"), {
			target: { value: "filtered" },
		});
		screen.getByRole("button", { name: "Apply" }).click();
		await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

		screen.getByRole("button", { name: "Reset" }).click();
		await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));

		await act(async () => {
			resolveReset(response("unfiltered", "unfiltered"));
			await resetRequest;
		});
		expect(await screen.findByText("unfiltered…")).not.toBeNull();

		await act(async () => {
			resolveFiltered(response("filtered", "filtered"));
			await filteredRequest;
		});
		expect(screen.queryByText("filtered…")).toBeNull();
		expect(screen.getByText("unfiltered…")).not.toBeNull();
	});

	it("does not reuse the previous cursor while replacement filters are loading", async () => {
		let resolveReplacement: (value: {
			ok: true;
			json: () => Promise<{ events: never[]; next_cursor: null }>;
		}) => void = () => undefined;
		const replacementRequest = new Promise<{
			ok: true;
			json: () => Promise<{ events: never[]; next_cursor: null }>;
		}>((resolve) => {
			resolveReplacement = resolve;
		});
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					events: [
						{
							id: "initial",
							event_type: "created",
							key_prefix: "initial",
							details: {},
							created_at: "2026-07-29T00:00:00Z",
						},
					],
					next_cursor: "old-cursor",
				}),
			})
			.mockReturnValueOnce(replacementRequest)
			.mockResolvedValue({
				ok: true,
				json: async () => ({ events: [], next_cursor: null }),
			});
		vi.stubGlobal("fetch", fetchMock);

		render(<AuditFeed />);
		const staleLoadMoreButton = await screen.findByRole("button", {
			name: "Load more",
		});
		fireEvent.change(screen.getByLabelText("Key prefix"), {
			target: { value: "filtered" },
		});

		await act(async () => {
			screen.getByRole("button", { name: "Apply" }).click();
			staleLoadMoreButton.click();
		});

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(fetchMock.mock.calls[1]?.[0]).toBe(
			"/api/keys/audit?limit=50&key_prefix=filtered",
		);

		await act(async () => {
			resolveReplacement({
				ok: true,
				json: async () => ({ events: [], next_cursor: null }),
			});
			await replacementRequest;
		});
	});

	it("ignores a second Load-more click while an append is still in flight", async () => {
		// AXI-7 review round 1: concurrent appends share one generation, so two
		// Load-more activations racing the disabled-state re-render could both
		// fire and merge pages in arrival order. appendInFlight admits one
		// append at a time.
		let resolveAppend: (value: {
			ok: true;
			json: () => Promise<{ events: never[]; next_cursor: null }>;
		}) => void = () => undefined;
		const appendRequest = new Promise<{
			ok: true;
			json: () => Promise<{ events: never[]; next_cursor: null }>;
		}>((resolve) => {
			resolveAppend = resolve;
		});
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					events: [
						{
							id: "initial",
							event_type: "created",
							key_prefix: "initial",
							details: {},
							created_at: "2026-07-29T00:00:00Z",
						},
					],
					next_cursor: "cursor-1",
				}),
			})
			.mockReturnValueOnce(appendRequest)
			.mockResolvedValue({
				ok: true,
				json: async () => ({ events: [], next_cursor: null }),
			});
		vi.stubGlobal("fetch", fetchMock);

		render(<AuditFeed />);
		const loadMoreButton = await screen.findByRole("button", {
			name: "Load more",
		});

		await act(async () => {
			loadMoreButton.click();
			// Second activation lands before the disabled re-render commits.
			loadMoreButton.click();
		});

		// Only the initial load + ONE append were issued; the racing second
		// click was dropped by appendInFlight.
		expect(fetchMock).toHaveBeenCalledTimes(2);

		await act(async () => {
			resolveAppend({
				ok: true,
				json: async () => ({ events: [], next_cursor: null }),
			});
			await appendRequest;
		});
	});
});

describe("AuditDrawerButton", () => {
	it("renders canonical rotated and SSO events with the shared mapping", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: true,
				json: async () => ({
					events: [
						{
							id: "rotated",
							event_type: "rotated",
							details: {},
							created_at: "2026-07-29T00:00:00Z",
						},
						{
							id: "sso-issued",
							event_type: "sso_issued",
							details: {},
							created_at: "2026-07-29T00:00:00Z",
						},
					],
				}),
			}),
		);

		render(
			<AuditDrawerButton
				keyId="key-1"
				keyPrefix="rs_live_test"
				keyName="Production"
			/>,
		);
		screen.getByRole("button", { name: "Audit" }).click();

		expect((await screen.findByText("Rotated")).className).toContain(
			"text-sky-300",
		);
		expect(screen.getByText("SSO issued").className).toContain(
			"text-violet-300",
		);
	});

	it("keeps unknown drawer events visible with the neutral fallback", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: true,
				json: async () => ({
					events: [
						{
							id: "future",
							event_type: "future_event",
							details: {},
							created_at: "2026-07-29T00:00:00Z",
						},
					],
				}),
			}),
		);

		render(
			<AuditDrawerButton
				keyId="key-1"
				keyPrefix="rs_live_test"
				keyName="Production"
			/>,
		);
		screen.getByRole("button", { name: "Audit" }).click();

		const badge = await screen.findByText("future_event");
		expect(badge.className).toContain("bg-neutral-500/[0.12]");
		expect(badge.className).toContain("text-neutral-300");
	});
});
