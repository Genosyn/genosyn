import { Outlet } from "react-router-dom";
import { ContextualLayout } from "../components/AppShell";

/**
 * Resources pages otherwise render directly inside AppShell. Give them the
 * shared contextual shell so their product-scoped Integrations link lives in
 * the same sidebar position as every other product.
 */
export default function ResourcesLayout() {
  return (
    <ContextualLayout>
      <Outlet />
    </ContextualLayout>
  );
}
