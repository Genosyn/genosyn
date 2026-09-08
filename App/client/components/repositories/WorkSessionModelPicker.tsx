import React from "react";
import { Select } from "@/components/ui/Select";
import type { WorkSessionModel } from "@/lib/api";

export function WorkSessionModelPicker({
  models,
  modelId,
  onChange,
  disabled = false,
}: {
  models: WorkSessionModel[];
  modelId: string | null;
  onChange: (modelId: string) => void;
  disabled?: boolean;
}) {
  if (models.length <= 1) return null;
  return (
    <Select
      label="AI Model"
      value={modelId ?? ""}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
      containerClassName="w-full min-w-0 sm:w-72"
    >
      {!modelId && (
        <option value="" disabled>
          No connected AI Model
        </option>
      )}
      {models.map((model) => (
        <option key={model.id} value={model.id} disabled={model.status !== "connected"}>
          {model.label}
          {model.isActive ? " (default)" : ""}
          {model.status !== "connected" ? " — Not connected" : ""}
        </option>
      ))}
    </Select>
  );
}
