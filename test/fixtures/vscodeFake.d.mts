/**
 * Type surface of the fake `vscode` module used by host-free suites.
 *
 * The host-compatible types live in `@types/vscode`; these declarations only
 * describe enough of the fake's runtime shape for tests that import it
 * directly (e.g. `test/copilotClient.test.ts`) to compile.
 */

export const window: {
  showInputBox: (options: unknown) => Promise<unknown>;
  showInformationMessage: (message: unknown, ...args: unknown[]) => Promise<unknown>;
  showWarningMessage: (message: unknown, ...args: unknown[]) => Promise<unknown>;
  showErrorMessage: (message: unknown, ...args: unknown[]) => Promise<unknown>;
  registerWebviewViewProvider: (viewId: unknown, provider: unknown, options?: unknown) => void;
};

export const commands: {
  executeCommand: (command: string, ...args: unknown[]) => Promise<unknown>;
};

export const workspace: {
  createFileSystemWatcher: (pattern: unknown, ...args: unknown[]) => unknown;
};

export class RelativePattern {
  constructor(base: unknown, pattern: unknown);
}

export const Uri: {
  file: (path: string) => { fsPath: string; path: string; scheme: string };
  joinPath: (base: unknown, ...segments: string[]) => unknown;
};

export class Disposable {
  constructor(callOnDispose?: () => void);
  dispose(): void;
  static from(...disposables: unknown[]): Disposable;
}

export const ViewColumn: { Active: number; Beside: number; One: number; Two: number; Three: number };

export const LanguageModelChatMessageRole: { User: number; Assistant: number };

export class LanguageModelTextPart {
  public readonly value: string;
  constructor(value: string);
}

export class LanguageModelToolCallPart {
  public readonly callId: string;
  public readonly name: string;
  public readonly input: unknown;
  constructor(callId: string, name: string, input: unknown);
}

export class LanguageModelToolResultPart {
  public readonly callId: string;
  public readonly content: unknown[];
  constructor(callId: string, content: unknown[]);
}

export class LanguageModelChatMessage {
  public readonly role: number;
  public readonly content: unknown[];
  public readonly name: string | undefined;
  constructor(role: number, content: string | unknown[], name?: string);
  static User(content: string | unknown[], name?: string): LanguageModelChatMessage;
  static Assistant(content: string | unknown[], name?: string): LanguageModelChatMessage;
}

export const LanguageModelChatToolMode: { Auto: number; Required: number };

export class LanguageModelError extends Error {
  public readonly code: string;
  constructor(code: string, message?: string);
  static NotFound(message?: string): LanguageModelError;
  static NoPermissions(message?: string): LanguageModelError;
  static Blocked(message?: string): LanguageModelError;
}

export class CancellationTokenSource {
  public readonly token: {
    readonly isCancellationRequested: boolean;
    readonly onCancellationRequested: (cb: () => void) => { dispose(): void };
  };
  public readonly isCancellationRequested: boolean;
  public readonly disposed: boolean;
  cancel(): void;
  dispose(): void;
}

export const lm: {
  selectChatModels: (selector: { vendor: string }) => Promise<unknown[]>;
};
