import React from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";
import { clsx } from "./clsx";

type SearchableOption = {
  disabled: boolean;
  group?: string;
  id: number;
  label: string;
  searchText: string;
  value: string;
};

export type SelectProps = React.SelectHTMLAttributes<HTMLSelectElement> & {
  containerClassName?: string;
  emptyMessage?: string;
  label?: string;
  onSearchChange?: (query: string) => void;
  searchPlaceholder?: string;
};

function nodeText(node: React.ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (React.isValidElement<{ children?: React.ReactNode }>(node)) {
    return nodeText(node.props.children);
  }
  return "";
}

function normaliseSearch(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase();
}

function collectOptions(children: React.ReactNode): SearchableOption[] {
  const options: SearchableOption[] = [];

  function visit(nodes: React.ReactNode, group?: string, groupDisabled = false) {
    React.Children.forEach(nodes, (child) => {
      if (!React.isValidElement(child)) return;
      const props = child.props as {
        children?: React.ReactNode;
        "data-search-text"?: string | number;
        disabled?: boolean;
        label?: React.ReactNode;
        value?: string | number | readonly string[];
      };

      if (child.type === "option") {
        const label = nodeText(props.label ?? props.children).trim();
        const rawValue = props.value ?? label;
        const value = Array.isArray(rawValue) ? rawValue.join(",") : String(rawValue);
        options.push({
          disabled: groupDisabled || Boolean(props.disabled),
          group,
          id: options.length,
          label,
          searchText: normaliseSearch(
            `${label} ${value} ${group ?? ""} ${props["data-search-text"] ?? ""}`,
          ),
          value,
        });
        return;
      }

      if (child.type === "optgroup") {
        const nextGroup = nodeText(props.label).trim();
        visit(props.children, nextGroup, groupDisabled || Boolean(props.disabled));
        return;
      }

      if (child.type === React.Fragment) visit(props.children, group, groupDisabled);
    });
  }

  visit(children);
  return options;
}

function toValues(
  value: string | number | readonly string[] | undefined,
  multiple: boolean,
): string[] {
  if (multiple) {
    if (Array.isArray(value)) return value.map(String);
    return value === undefined ? [] : [String(value)];
  }
  if (value === undefined || Array.isArray(value)) return [];
  return [String(value)];
}

function setForwardedRef(
  forwardedRef: React.ForwardedRef<HTMLSelectElement>,
  element: HTMLSelectElement | null,
) {
  if (typeof forwardedRef === "function") forwardedRef(element);
  else if (forwardedRef) forwardedRef.current = element;
}

export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(function Select(
  {
    "aria-describedby": ariaDescribedBy,
    "aria-label": ariaLabel,
    "aria-labelledby": ariaLabelledBy,
    autoFocus,
    children,
    className,
    containerClassName,
    defaultValue,
    disabled = false,
    emptyMessage = "No options found",
    id,
    label,
    multiple = false,
    onChange,
    onSearchChange,
    required,
    searchPlaceholder = "Search options…",
    title,
    value,
    ...nativeProps
  },
  forwardedRef,
) {
  const generatedId = React.useId();
  const selectId = id ?? generatedId;
  const listboxId = `${selectId}-listbox`;
  const nativeRef = React.useRef<HTMLSelectElement | null>(null);
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const wrapperRef = React.useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [activeIndex, setActiveIndex] = React.useState(0);
  const [popupStyle, setPopupStyle] = React.useState<React.CSSProperties>({});
  const [uncontrolledValue, setUncontrolledValue] = React.useState<
    string | number | readonly string[] | undefined
  >(() => defaultValue);
  const options = React.useMemo(() => collectOptions(children), [children]);
  const currentValue = value === undefined ? uncontrolledValue : value;
  const selectedValues = React.useMemo(
    () => {
      const explicitValues = toValues(currentValue, multiple);
      if (
        explicitValues.length > 0 ||
        multiple ||
        value !== undefined ||
        defaultValue !== undefined
      ) {
        return explicitValues;
      }
      const firstOption = options.find((option) => !option.disabled);
      return firstOption ? [firstOption.value] : [];
    },
    [currentValue, defaultValue, multiple, options, value],
  );
  const selectedSet = React.useMemo(() => new Set(selectedValues), [selectedValues]);
  const selectedOptions = options.filter((option) => selectedSet.has(option.value));
  const displayValue = selectedOptions.map((option) => option.label).join(", ");
  const searchTerms = React.useMemo(
    () => normaliseSearch(query).split(/\s+/).filter(Boolean),
    [query],
  );
  const filteredOptions = React.useMemo(
    () =>
      options.filter((option) =>
        searchTerms.every((term) => option.searchText.includes(term)),
      ),
    [options, searchTerms],
  );

  React.useEffect(() => {
    if (!open) return;
    const selectedIndex = filteredOptions.findIndex(
      (option) => selectedSet.has(option.value) && !option.disabled,
    );
    const firstEnabled = filteredOptions.findIndex((option) => !option.disabled);
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : Math.max(0, firstEnabled));
  }, [filteredOptions, open, selectedSet]);

  React.useEffect(() => {
    if (open) onSearchChange?.(query);
  }, [onSearchChange, open, query]);

  React.useLayoutEffect(() => {
    if (!open) return;

    function positionPopup() {
      const input = inputRef.current;
      if (!input) return;
      const rect = input.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      const openAbove = spaceBelow < 220 && rect.top > spaceBelow;
      const popupWidth = Math.min(rect.width, window.innerWidth - 16);
      setPopupStyle({
        bottom: openAbove ? window.innerHeight - rect.top + 4 : undefined,
        left: Math.max(8, Math.min(rect.left, window.innerWidth - popupWidth - 8)),
        maxHeight: Math.max(120, Math.min(256, openAbove ? rect.top - 12 : spaceBelow - 12)),
        top: openAbove ? undefined : rect.bottom + 4,
        width: popupWidth,
      });
    }

    positionPopup();
    window.addEventListener("resize", positionPopup);
    window.addEventListener("scroll", positionPopup, true);
    return () => {
      window.removeEventListener("resize", positionPopup);
      window.removeEventListener("scroll", positionPopup, true);
    };
  }, [open]);

  const assignNativeRef = React.useCallback(
    (element: HTMLSelectElement | null) => {
      nativeRef.current = element;
      setForwardedRef(forwardedRef, element);
    },
    [forwardedRef],
  );

  function handleNativeChange(event: React.ChangeEvent<HTMLSelectElement>) {
    if (value === undefined) {
      setUncontrolledValue(
        multiple
          ? Array.from(event.target.selectedOptions, (option) => option.value)
          : event.target.value,
      );
    }
    onChange?.(event);
  }

  function dispatchChange(nextValues: string[]) {
    const nativeSelect = nativeRef.current;
    if (!nativeSelect) return;

    if (multiple) {
      Array.from(nativeSelect.options).forEach((option) => {
        option.selected = nextValues.includes(option.value);
      });
    } else {
      nativeSelect.value = nextValues[0] ?? "";
    }
    nativeSelect.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function choose(option: SearchableOption) {
    if (option.disabled) return;
    if (multiple) {
      const nextValues = selectedSet.has(option.value)
        ? selectedValues.filter((selected) => selected !== option.value)
        : [...selectedValues, option.value];
      dispatchChange(nextValues);
      return;
    }

    dispatchChange([option.value]);
    setOpen(false);
    setQuery("");
  }

  function moveActive(direction: 1 | -1) {
    if (filteredOptions.length === 0) return;
    let next = activeIndex;
    for (let checked = 0; checked < filteredOptions.length; checked += 1) {
      next = (next + direction + filteredOptions.length) % filteredOptions.length;
      if (!filteredOptions[next]?.disabled) {
        setActiveIndex(next);
        return;
      }
    }
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        setQuery("");
      } else {
        moveActive(event.key === "ArrowDown" ? 1 : -1);
      }
      return;
    }
    if (event.key === "Enter" && open) {
      event.preventDefault();
      const option = filteredOptions[activeIndex];
      if (option) choose(option);
      return;
    }
    if (event.key === "Escape" && open) {
      event.preventDefault();
      setOpen(false);
      setQuery("");
    }
  }

  const customisesHeight = /(?:^|\s)!?(?:h-|min-h-|py-)/.test(className ?? "");

  return (
    <div ref={wrapperRef} className={clsx("relative flex min-w-0 flex-col gap-1", containerClassName)}>
      {label && (
        <label htmlFor={selectId} className="text-sm font-medium text-slate-700 dark:text-slate-300">
          {label}
        </label>
      )}
      <div className="relative">
        <input
          ref={inputRef}
          id={selectId}
          role="combobox"
          type="text"
          autoComplete="off"
          autoFocus={autoFocus}
          aria-autocomplete="list"
          aria-controls={listboxId}
          aria-describedby={ariaDescribedBy}
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-label={ariaLabel ?? (label ? undefined : "Select an option")}
          aria-labelledby={ariaLabelledBy}
          aria-multiselectable={multiple || undefined}
          aria-required={required || undefined}
          aria-activedescendant={
            open && filteredOptions[activeIndex]
              ? `${listboxId}-option-${filteredOptions[activeIndex].id}`
              : undefined
          }
          className={clsx(
            !customisesHeight && "h-10",
            "w-full rounded-lg border border-slate-200 bg-white px-3 pr-9 text-sm text-slate-900 shadow-sm",
            "dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100",
            "placeholder:text-slate-400 dark:placeholder:text-slate-500",
            "focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 dark:focus:ring-indigo-900",
            "disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-400 dark:disabled:bg-slate-800",
            className,
          )}
          disabled={disabled}
          placeholder={open ? searchPlaceholder : undefined}
          title={title}
          value={open ? query : displayValue}
          onBlur={(event) => {
            if (wrapperRef.current?.contains(event.relatedTarget)) return;
            setOpen(false);
            setQuery("");
          }}
          onChange={(event) => {
            setOpen(true);
            setQuery(event.target.value);
          }}
          onFocus={() => {
            setOpen(true);
            setQuery("");
          }}
          onClick={() => {
            if (!open) {
              setOpen(true);
              setQuery("");
            }
          }}
          onKeyDown={handleKeyDown}
        />
        <ChevronDown
          aria-hidden="true"
          size={16}
          className={clsx(
            "pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 transition-transform",
            open && "rotate-180",
          )}
        />
      </div>

      {open && !disabled && typeof document !== "undefined" && createPortal(
        <div
          id={listboxId}
          role="listbox"
          aria-multiselectable={multiple || undefined}
          style={popupStyle}
          className="fixed z-[80] overflow-y-auto rounded-lg border border-slate-200 bg-white p-1 shadow-lg dark:border-slate-700 dark:bg-slate-900"
        >
          {filteredOptions.length === 0 ? (
            <div className="px-3 py-2 text-sm text-slate-500 dark:text-slate-400">{emptyMessage}</div>
          ) : (
            filteredOptions.map((option, index) => {
              const showGroup = option.group && option.group !== filteredOptions[index - 1]?.group;
              const selected = selectedSet.has(option.value);
              return (
                <React.Fragment key={`${option.value}-${option.id}`}>
                  {showGroup && (
                    <div className="px-3 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
                      {option.group}
                    </div>
                  )}
                  <button
                    id={`${listboxId}-option-${option.id}`}
                    role="option"
                    type="button"
                    aria-disabled={option.disabled || undefined}
                    aria-selected={selected}
                    className={clsx(
                      "flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm",
                      index === activeIndex
                        ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-200"
                        : "text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-800",
                      option.disabled && "cursor-not-allowed opacity-50",
                    )}
                    disabled={option.disabled}
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => choose(option)}
                  >
                    <span className="min-w-0 flex-1 truncate">{option.label}</span>
                    <Check
                      aria-hidden="true"
                      size={15}
                      className={selected ? "shrink-0 text-indigo-600" : "invisible shrink-0"}
                    />
                  </button>
                </React.Fragment>
              );
            })
          )}
        </div>,
        document.body,
      )}

      <select
        {...nativeProps}
        ref={assignNativeRef}
        aria-hidden="true"
        className="sr-only"
        disabled={disabled}
        multiple={multiple}
        required={required}
        tabIndex={-1}
        value={multiple ? selectedValues : (selectedValues[0] ?? "")}
        onChange={handleNativeChange}
        onInvalid={(event) => {
          event.preventDefault();
          document.getElementById(selectId)?.focus();
        }}
      >
        {children}
      </select>
    </div>
  );
});
