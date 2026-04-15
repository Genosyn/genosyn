import React from "react";
import type { Employee } from "../lib/api";

export type EmployeesContextValue = {
  employees: Employee[];
  reload: () => Promise<void>;
};

export const EmployeesContext = React.createContext<EmployeesContextValue>({
  employees: [],
  reload: async () => {},
});

export function useEmployees(): EmployeesContextValue {
  return React.useContext(EmployeesContext);
}
