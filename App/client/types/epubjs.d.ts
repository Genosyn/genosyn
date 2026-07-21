declare module "epubjs" {
  export type Rendition = {
    display(target?: string): Promise<unknown>;
    prev(): Promise<unknown>;
    next(): Promise<unknown>;
    destroy(): void;
    on(event: string, listener: (value: unknown) => void): void;
    themes: {
      register(name: string, rules: Record<string, Record<string, string>>): void;
      select(name: string): void;
      fontSize(size: string): void;
    };
  };

  export type Book = {
    ready: Promise<unknown>;
    loaded: {
      navigation: Promise<{ toc?: unknown[] }>;
    };
    locations: {
      generate(chars: number): Promise<unknown>;
      percentageFromCfi(cfi: string): number;
    };
    renderTo(
      target: HTMLElement,
      options: Record<string, unknown>,
    ): Rendition;
    destroy(): void;
  };

  export default function ePub(input: string | ArrayBuffer): Book;
}
