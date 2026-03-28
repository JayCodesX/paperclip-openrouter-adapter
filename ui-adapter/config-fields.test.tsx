/**
 * Tests for OpenRouterConfigFields
 *
 * Requires:
 *   @testing-library/react   (npm i -D @testing-library/react @testing-library/user-event)
 *   jsdom environment         (vitest --environment jsdom, or add `environment: "jsdom"` in vitest.config)
 *
 * When installed into Paperclip via install.sh these tests run under the UI
 * package's vitest setup. For standalone runs from this repo, create a
 * ui-adapter/vitest.config.ts with { test: { environment: "jsdom" } } and
 * install the testing-library deps.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { AdapterConfigFieldsProps } from "../types";

// ---------------------------------------------------------------------------
// Mock agent-config-primitives with minimal HTML implementations so the tests
// don't need Radix UI, lucide-react, or any other heavy dependency.
// ---------------------------------------------------------------------------
vi.mock("../../components/agent-config-primitives", () => ({
  Field: ({ label, children }: { label: string; children: React.ReactNode }) => (
    <div>
      <label>{label}</label>
      {children}
    </div>
  ),
  ToggleField: ({
    label,
    checked,
    onChange,
  }: {
    label: string;
    checked: boolean;
    onChange: (v: boolean) => void;
  }) => (
    <button
      type="button"
      aria-label={label}
      aria-checked={checked}
      onClick={() => onChange(!checked)}
    >
      {label}
    </button>
  ),
  DraftInput: ({
    value,
    onCommit,
    placeholder,
    className,
    immediate: _immediate,
    ...rest
  }: {
    value: string;
    onCommit: (v: string) => void;
    placeholder?: string;
    className?: string;
    immediate?: boolean;
    [k: string]: unknown;
  }) => (
    <input
      value={value}
      placeholder={placeholder}
      onChange={(e) => onCommit(e.target.value)}
      {...rest}
    />
  ),
  DraftNumberInput: ({
    value,
    onCommit,
    className,
    immediate: _immediate,
    ...rest
  }: {
    value: number;
    onCommit: (v: number) => void;
    className?: string;
    immediate?: boolean;
    [k: string]: unknown;
  }) => (
    <input
      type="number"
      value={value}
      onChange={(e) => onCommit(Number(e.target.value))}
      {...rest}
    />
  ),
  DraftTextarea: ({
    value,
    onCommit,
    placeholder,
    immediate: _immediate,
    minRows: _minRows,
  }: {
    value: string;
    onCommit: (v: string) => void;
    placeholder?: string;
    immediate?: boolean;
    minRows?: number;
  }) => (
    <textarea
      value={value}
      placeholder={placeholder}
      onChange={(e) => onCommit(e.target.value)}
    />
  ),
  help: {
    model: "Override the default model.",
    maxTurnsPerRun: "Max turns per run.",
    timeoutSec: "Timeout in seconds.",
    dangerouslySkipPermissions: "Skip permission prompts.",
  },
}));

// Import *after* mocks are registered
import { OpenRouterConfigFields } from "./config-fields";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProps(overrides: Partial<AdapterConfigFieldsProps> = {}): AdapterConfigFieldsProps {
  return {
    mode: "create",
    isCreate: true,
    adapterType: "openrouter",
    values: {},
    set: vi.fn(),
    config: {},
    eff: (_group, _field, original) => original as never,
    mark: vi.fn(),
    models: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OpenRouterConfigFields", () => {
  // 1. Renders without crashing
  it("renders without crashing (isCreate, empty values)", () => {
    const props = makeProps();
    render(<OpenRouterConfigFields {...props} />);
    expect(screen.getByPlaceholderText("sk-or-...")).toBeDefined();
  });

  // 2. wakeReasonModels — add a row
  it("wakeReasonModels: add a row calls set with correct object", () => {
    const set = vi.fn();
    render(<OpenRouterConfigFields {...makeProps({ set })} />);

    // Select a wake reason
    const reasonSelect = screen.getByRole("combobox", { name: /wake reason/i });
    fireEvent.change(reasonSelect, { target: { value: "manual" } });

    // Type a model
    const modelInput = screen.getByRole("textbox", { name: /wake reason model/i });
    fireEvent.change(modelInput, { target: { value: "anthropic/claude-opus-4-6" } });

    // Click add
    const addBtn = screen.getByRole("button", { name: /add wake reason/i });
    fireEvent.click(addBtn);

    expect(set).toHaveBeenCalledWith({
      wakeReasonModels: { manual: "anthropic/claude-opus-4-6" },
    });
  });

  // 3. wakeReasonModels — remove a row
  it("wakeReasonModels: remove a row calls set with empty object", () => {
    const set = vi.fn();
    render(
      <OpenRouterConfigFields
        {...makeProps({
          set,
          values: { wakeReasonModels: { manual: "anthropic/claude-opus-4-6" } },
        })}
      />,
    );

    const removeBtn = screen.getByRole("button", { name: /remove manual/i });
    fireEvent.click(removeBtn);

    expect(set).toHaveBeenCalledWith({ wakeReasonModels: {} });
  });

  // 4. turnModelRules — add a rule
  it("turnModelRules: add a rule calls set with correct array", () => {
    const set = vi.fn();
    render(<OpenRouterConfigFields {...makeProps({ set })} />);

    // Fill model input
    const modelInput = screen.getByRole("textbox", { name: /rule model/i });
    fireEvent.change(modelInput, { target: { value: "anthropic/claude-sonnet-4-6" } });

    // Fill afterTurn
    const afterTurnInput = screen.getByRole("spinbutton", { name: /rule after turn/i });
    fireEvent.change(afterTurnInput, { target: { value: "5" } });

    // Click add
    const addBtn = screen.getByRole("button", { name: /\+ add rule/i });
    fireEvent.click(addBtn);

    expect(set).toHaveBeenCalledWith({
      turnModelRules: [{ model: "anthropic/claude-sonnet-4-6", afterTurn: 5 }],
    });
  });

  // 5. turnModelRules — remove a rule
  it("turnModelRules: remove a rule calls set with empty array", () => {
    const set = vi.fn();
    render(
      <OpenRouterConfigFields
        {...makeProps({
          set,
          values: {
            turnModelRules: [{ model: "deepseek/deepseek-r1", afterTurn: 3 }],
          },
        })}
      />,
    );

    const removeBtn = screen.getByRole("button", { name: /remove rule 0/i });
    fireEvent.click(removeBtn);

    expect(set).toHaveBeenCalledWith({ turnModelRules: [] });
  });

  // 6. Sampling — temperature commits correctly
  it("temperature: changing value calls set with correct number", () => {
    const set = vi.fn();
    render(<OpenRouterConfigFields {...makeProps({ set })} />);

    // Open the Sampling details section
    const samplingDetails = screen.getByText("Sampling").closest("summary")!;
    fireEvent.click(samplingDetails);

    // Temperature input (first number input after section opens)
    const tempInput = screen.getByDisplayValue("0", { selector: 'input[type="number"]' });
    // There are multiple — find by proximity to "Temperature" label
    const allZeroInputs = screen.getAllByDisplayValue("0");
    // Temperature is the first number input in the Sampling section
    // We rely on the first one rendered after opening Sampling
    fireEvent.change(allZeroInputs[0], { target: { value: "0.7" } });

    expect(set).toHaveBeenCalledWith({ temperature: 0.7 });
  });

  // 7. Reasoning effort select
  it("reasoning effort: changing to 'high' calls commitReasoning via set", () => {
    const set = vi.fn();
    render(<OpenRouterConfigFields {...makeProps({ set })} />);

    // Open Reasoning details
    const reasoningDetails = screen.getByText(/reasoning \(extended thinking\)/i).closest("summary")!;
    fireEvent.click(reasoningDetails);

    // Find the effort select — it renders as a <select> with "Default (none)" option
    const effortSelect = screen.getByDisplayValue("Default (none)");
    fireEvent.change(effortSelect, { target: { value: "high" } });

    expect(set).toHaveBeenCalledWith({
      reasoning: { effort: "high" },
    });
  });

  // 8. Provider order parses comma-separated input
  it("provider order: comma-separated input calls set with parsed array", () => {
    const set = vi.fn();
    render(<OpenRouterConfigFields {...makeProps({ set })} />);

    // Open Provider routing details
    const providerDetails = screen.getByText(/provider routing/i).closest("summary")!;
    fireEvent.click(providerDetails);

    const orderInput = screen.getByPlaceholderText("DeepSeek,Together");
    fireEvent.change(orderInput, { target: { value: "DeepSeek,Together" } });

    expect(set).toHaveBeenCalledWith({
      provider: { order: ["DeepSeek", "Together"] },
    });
  });

  // 9. requiredEnvVars parses comma-separated
  it("requiredEnvVars: comma-separated input calls set with parsed array", () => {
    const set = vi.fn();
    render(<OpenRouterConfigFields {...makeProps({ set })} />);

    const input = screen.getByPlaceholderText("GITHUB_TOKEN,LINEAR_API_KEY");
    fireEvent.change(input, { target: { value: "GITHUB_TOKEN,LINEAR_API_KEY" } });

    expect(set).toHaveBeenCalledWith({
      requiredEnvVars: ["GITHUB_TOKEN", "LINEAR_API_KEY"],
    });
  });

  // 10. apiKeys parses comma-separated
  it("apiKeys: comma-separated input calls set with parsed array", () => {
    const set = vi.fn();
    render(<OpenRouterConfigFields {...makeProps({ set })} />);

    const input = screen.getByPlaceholderText("sk-or-key2,sk-or-key3");
    fireEvent.change(input, { target: { value: "key1,key2" } });

    expect(set).toHaveBeenCalledWith({ apiKeys: ["key1", "key2"] });
  });

  // 11. Edit path — fields show correct values via eff()
  it("edit path: fields show correct current values via eff()", () => {
    const eff = vi.fn((_group: string, field: string, original: unknown) => {
      const vals: Record<string, unknown> = {
        apiKey: "sk-or-existing",
        model: "anthropic/claude-opus-4-6",
        cliPath: "/usr/local/bin/orager",
        daemonUrl: "http://127.0.0.1:9999",
      };
      return (vals[field] ?? original) as never;
    });

    render(
      <OpenRouterConfigFields
        {...makeProps({
          isCreate: false,
          mode: "edit",
          values: null,
          set: null,
          config: {
            apiKey: "sk-or-existing",
            model: "anthropic/claude-opus-4-6",
            cliPath: "/usr/local/bin/orager",
            daemonUrl: "http://127.0.0.1:9999",
          },
          eff,
        })}
      />,
    );

    expect(screen.getByDisplayValue("sk-or-existing")).toBeDefined();
    expect(screen.getByDisplayValue("anthropic/claude-opus-4-6")).toBeDefined();
    expect(screen.getByDisplayValue("/usr/local/bin/orager")).toBeDefined();
    expect(screen.getByDisplayValue("http://127.0.0.1:9999")).toBeDefined();
  });

  // 13. fallbackModel — dropdown shows all models
  it("fallbackModel: dropdown includes all models (regardless of supportsVision)", () => {
    const modelList = [
      { id: "openai/gpt-4o", label: "GPT-4o", supportsVision: true },
      { id: "deepseek/deepseek-r1", label: "DeepSeek R1", supportsVision: false },
    ];
    render(<OpenRouterConfigFields {...makeProps({ models: modelList })} />);

    const select = screen.getByRole("combobox", { name: /fallback model/i });
    const options = Array.from(select.querySelectorAll("option")).map((o) => o.value);

    expect(options).toContain("openai/gpt-4o");
    expect(options).toContain("deepseek/deepseek-r1");
  });

  // 14. visionModel — dropdown only shows supportsVision models
  it("visionModel: dropdown excludes models where supportsVision is false", () => {
    const modelList = [
      { id: "openai/gpt-4o", label: "GPT-4o", supportsVision: true },
      { id: "deepseek/deepseek-r1", label: "DeepSeek R1", supportsVision: false },
      { id: "google/gemini-flash", label: "Gemini Flash", supportsVision: true },
    ];
    render(<OpenRouterConfigFields {...makeProps({ models: modelList })} />);

    const select = screen.getByRole("combobox", { name: /vision model/i });
    const options = Array.from(select.querySelectorAll("option")).map((o) => o.value);

    expect(options).toContain("openai/gpt-4o");
    expect(options).toContain("google/gemini-flash");
    expect(options).not.toContain("deepseek/deepseek-r1");
  });

  // 15. Both fields are optional — no error when values absent, onChange calls set correctly
  it("fallbackModel and visionModel are optional — absent values render without error", () => {
    // Empty values (no fallbackModel or visionModel set) — should not throw
    expect(() =>
      render(<OpenRouterConfigFields {...makeProps({ values: {} })} />),
    ).not.toThrow();
  });

  it("fallbackModel onChange calls set with selected model id", () => {
    const set = vi.fn();
    const modelList = [
      { id: "openai/gpt-4o", label: "GPT-4o", supportsVision: true },
      { id: "deepseek/deepseek-r1", label: "DeepSeek R1", supportsVision: false },
    ];
    render(<OpenRouterConfigFields {...makeProps({ set, models: modelList })} />);

    const select = screen.getByRole("combobox", { name: /fallback model/i });
    fireEvent.change(select, { target: { value: "openai/gpt-4o" } });

    expect(set).toHaveBeenCalledWith({ fallbackModel: "openai/gpt-4o" });
  });

  it("visionModel onChange calls set with selected model id", () => {
    const set = vi.fn();
    const modelList = [
      { id: "openai/gpt-4o", label: "GPT-4o", supportsVision: true },
      { id: "google/gemini-flash", label: "Gemini Flash", supportsVision: true },
    ];
    render(<OpenRouterConfigFields {...makeProps({ set, models: modelList })} />);

    const select = screen.getByRole("combobox", { name: /vision model/i });
    fireEvent.change(select, { target: { value: "google/gemini-flash" } });

    expect(set).toHaveBeenCalledWith({ visionModel: "google/gemini-flash" });
  });

  // 12. Collapsible sections start closed
  it("collapsible sections (Sampling, Reasoning, Provider routing) start closed", () => {
    const { container } = render(<OpenRouterConfigFields {...makeProps()} />);

    const detailsEls = container.querySelectorAll("details");
    // There are 3 top-level collapsible sections + 1 nested (Advanced cost overrides)
    // All should start without the `open` attribute
    detailsEls.forEach((el) => {
      expect(el.hasAttribute("open")).toBe(false);
    });
  });

  // 13. memoryRetrieval select renders with "local" and "embedding" options
  it("memoryRetrieval: select renders with 'local' and 'embedding' options", () => {
    render(<OpenRouterConfigFields {...makeProps()} />);

    const select = screen.getByRole("combobox", { name: /memory retrieval mode/i });
    expect(select).toBeDefined();

    const options = Array.from(select.querySelectorAll("option")).map((o) => o.value);
    expect(options).toContain("local");
    expect(options).toContain("embedding");
  });

  // 14. Changing memoryRetrieval to "embedding" calls set with correct value
  it("memoryRetrieval: changing to 'embedding' calls set with correct value", () => {
    const set = vi.fn();
    render(<OpenRouterConfigFields {...makeProps({ set })} />);

    const select = screen.getByRole("combobox", { name: /memory retrieval mode/i });
    fireEvent.change(select, { target: { value: "embedding" } });

    expect(set).toHaveBeenCalledWith({ memoryRetrieval: "embedding" });
  });

  // 15. memoryEmbeddingModel input commits correctly
  it("memoryEmbeddingModel: input commits correctly", () => {
    const set = vi.fn();
    render(<OpenRouterConfigFields {...makeProps({ set })} />);

    const input = screen.getByPlaceholderText("openai/text-embedding-3-small");
    fireEvent.change(input, { target: { value: "openai/text-embedding-3-small" } });

    expect(set).toHaveBeenCalledWith({ memoryEmbeddingModel: "openai/text-embedding-3-small" });
  });

  // 16. memoryMaxChars input renders and onChange fires set() correctly
  it("memoryMaxChars: input renders and onChange fires set() correctly", () => {
    const set = vi.fn();
    render(<OpenRouterConfigFields {...makeProps({ set })} />);

    const label = screen.getByText("Memory Max Chars");
    expect(label).toBeDefined();

    // Find the number input associated with this field by querying all number inputs
    // and firing change on the one near Memory Max Chars
    const allNumberInputs = screen.getAllByRole("spinbutton");
    // Find the memoryMaxChars input — it should have value "0" (default)
    // We find by proximity to the "Memory Max Chars" label
    const fieldContainer = label.closest("div")!;
    const input = fieldContainer.querySelector('input[type="number"]')!;
    fireEvent.change(input, { target: { value: "4000" } });

    expect(set).toHaveBeenCalledWith({ memoryMaxChars: 4000 });
  });

  // 17. maxIdenticalToolCallTurns input renders and onChange fires set() correctly
  it("maxIdenticalToolCallTurns: input renders and onChange fires set() correctly", () => {
    const set = vi.fn();
    render(<OpenRouterConfigFields {...makeProps({ set })} />);

    const label = screen.getByText("Max Identical Tool Call Turns");
    expect(label).toBeDefined();

    const fieldContainer = label.closest("div")!;
    const input = fieldContainer.querySelector('input[type="number"]')!;
    fireEvent.change(input, { target: { value: "5" } });

    expect(set).toHaveBeenCalledWith({ maxIdenticalToolCallTurns: 5 });
  });

  // 18. approvalMode select has "question" and "auto" options and onChange fires set()
  it("approvalMode: select has 'question' and 'auto' options and onChange fires set()", () => {
    const set = vi.fn();
    render(<OpenRouterConfigFields {...makeProps({ set })} />);

    const select = screen.getByRole("combobox", { name: /approval mode/i });
    expect(select).toBeDefined();

    const options = Array.from(select.querySelectorAll("option")).map((o) => o.value);
    expect(options).toContain("question");
    expect(options).toContain("auto");

    fireEvent.change(select, { target: { value: "question" } });
    expect(set).toHaveBeenCalledWith({ approvalMode: "question" });
  });
});
