// @vitest-environment jsdom

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  EFFECTIVE_DISPATCHABLE_CHAT_MODELS,
  EFFECTIVE_PUBLIC_MODELS,
} from "@routeshift/shared";
import { CURRENT_MODEL_ROLES, CURRENT_MODELS } from "@/lib/current-models";
import { ModelAutocomplete } from "@/components/models/model-autocomplete";
afterEach(cleanup);

describe("ModelAutocomplete", () => {
  it("orders current-role quick picks first and covers every effective dispatchable chat model", () => {
    const chatModels = EFFECTIVE_DISPATCHABLE_CHAT_MODELS;
    const embeddingModels = EFFECTIVE_PUBLIC_MODELS.filter((model) => (
      "kind" in model && model.kind === "embedding"
    ));
    const currentNames = CURRENT_MODEL_ROLES.map((role) => CURRENT_MODELS[role]);
    render(<ModelAutocomplete value="" onChange={() => undefined} />);

    fireEvent.focus(screen.getByRole("textbox"));

    expect(screen.getByText("Popular")).toBeTruthy();
    const optionButtons = screen.getAllByRole("button").filter((button) =>
      chatModels.some((model) => button.textContent === `${model.canonical_name}${model.provider}`),
    );
    const optionNames = optionButtons.map((button) =>
      chatModels.find((model) => button.textContent === `${model.canonical_name}${model.provider}`)!.canonical_name,
    );
    expect(optionNames.slice(0, currentNames.length)).toEqual(currentNames);
    expect(new Set(optionNames)).toEqual(new Set(chatModels.map((model) => model.canonical_name)));
    for (const embedding of embeddingModels) {
      expect(optionNames).not.toContain(embedding.canonical_name);
    }
  });

  it("selects and serializes a popular model from the dropdown", () => {
    const onChange = vi.fn();
    render(<ModelAutocomplete value="" onChange={onChange} />);

    fireEvent.focus(screen.getByRole("textbox"));
    fireEvent.click(screen.getByText(CURRENT_MODELS.default));

    expect(onChange).toHaveBeenCalledWith(CURRENT_MODELS.default);
    expect(screen.queryByText("Popular")).toBeNull();
  });

  it("preserves the keyboard shortcut for selecting the top popular model", () => {
    const onChange = vi.fn();
    render(<ModelAutocomplete value="" onChange={onChange} />);

    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });

    expect(onChange).toHaveBeenCalledWith(CURRENT_MODELS.default);
  });

  it("gives the retained clear-selection control an accessible name", () => {
    render(<ModelAutocomplete value={CURRENT_MODELS.default} onChange={() => undefined} />);

    expect(
      screen.getByRole("button", { name: "Clear model selection" }),
    ).toBeTruthy();
  });
});
