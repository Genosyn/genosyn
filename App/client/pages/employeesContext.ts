import React from "react";
import type { Employee } from "../lib/api";

export type EmployeesContextValue = {
  employees: Employee[];
  /**
   * The roster's first read hasn't come back yet. `employees` is empty then
   * too, so a page must not take it for "nobody is hired" and offer to hire
   * the first one.
   */
  loading: boolean;
  reload: () => Promise<void>;
};

export const EmployeesContext = React.createContext<EmployeesContextValue>({
  employees: [],
  loading: false,
  reload: async () => {},
});

export function useEmployees(): EmployeesContextValue {
  return React.useContext(EmployeesContext);
}
