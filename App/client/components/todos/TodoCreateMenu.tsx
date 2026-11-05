import React from "react";
import { useNavigate } from "react-router-dom";
import { ChevronDown, FileText, Plus, Receipt } from "lucide-react";

import { FROM_TODO_PARAM } from "@/components/todos/linkFromTodo";
import { Button } from "@/components/ui/Button";
import { Menu, MenuItem } from "@/components/ui/Menu";

/**
 * Do the work a Todo asks for, from the Todo: the usual form, with what it saves linked
 * back. Shown to whoever can use Finance, which the forms and the server check again.
 */
export function TodoCreateMenu({
  todoId,
  companySlug,
}: {
  todoId: string;
  companySlug: string;
}) {
  const navigate = useNavigate();
  const open = (folder: string) =>
    navigate(`/c/${companySlug}/finance/${folder}/new?${FROM_TODO_PARAM}=${todoId}`);
  return (
    <Menu
      width={180}
      trigger={({ ref, onClick }) => (
        <Button ref={ref} size="sm" variant="secondary" onClick={onClick}>
          <Plus size={13} className="mr-1.5" /> Create
          <ChevronDown size={12} className="ml-1" />
        </Button>
      )}
    >
      {(close) => (
        <>
          <MenuItem
            icon={<FileText size={14} />}
            label="Estimate"
            onSelect={() => {
              close();
              open("estimates");
            }}
          />
          <MenuItem
            icon={<Receipt size={14} />}
            label="Invoice"
            onSelect={() => {
              close();
              open("invoices");
            }}
          />
        </>
      )}
    </Menu>
  );
}
