import * as React from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import PreviewScreen from "./access/preview";
import MatrixScreen from "./access/matrix";
import TrailScreen from "./access/trail";
import GrantsScreen from "./access/grants";
import TreeScreen from "./access/tree";

/**
 * Admin Console → Access Control (PRD §30), whose headline feature is §31's
 * "View Access As User".
 *
 * Everything shown here is resolved SERVER-SIDE by the same decide() the
 * authorize() middleware calls — this page renders an answer, it does not
 * compute one. That is the whole reason the preview can be trusted to explain a
 * 403 a user is actually seeing.
 *
 * Denials are rendered EXPLICITLY with their reason. The PRD's mock shows
 * "Approve ✗" as a row, not an omission, because "why can't they?" is the
 * question this page exists to answer.
 */

/** Shared trigger styling for this strip — roomier than the app default. */
const TAB =
  "rounded-lg px-3 py-1.5 text-[13px] text-[var(--muted)] transition-colors " +
  "hover:text-[var(--ink)] data-[state=active]:bg-[var(--muted-bg)] " +
  "data-[state=active]:text-[var(--ink)] data-[state=active]:shadow-none";

export default function AccessControlPage() {
  const [tab, setTab] = React.useState("preview");
  return (
    // The screens own their own headers (each states the question it answers),
    // so the shell is the tab strip and nothing else. Negative insets let a
    // screen's header span the full content width the way the design does.
    <Tabs value={tab} onValueChange={setTab} className="-mx-6 -mt-6 sm:-mx-8">
      {/* pb-3 matters: the active pill has a filled background, and with the
          strip flush to the hairline it read as sitting ON the rule rather than
          above it. h-auto lets the triggers set their own height instead of
          being squeezed into the shared TabsList row. */}
      <div className="border-b border-[var(--border)] bg-[var(--card)] px-6 pb-3 pt-4 sm:px-8">
        <TabsList className="h-auto gap-1 bg-transparent p-0">
          <TabsTrigger className={TAB} value="preview">Access preview</TabsTrigger>
          <TabsTrigger className={TAB} value="matrix">Permission matrix</TabsTrigger>
          <TabsTrigger className={TAB} value="grants">Grants</TabsTrigger>
          <TabsTrigger className={TAB} value="tree">Organization</TabsTrigger>
          <TabsTrigger className={TAB} value="trail">Activity trail</TabsTrigger>
        </TabsList>
      </div>
      <TabsContent value="preview" className="mt-0">
        <PreviewScreen onGoGrants={() => setTab("grants")} />
      </TabsContent>
      <TabsContent value="matrix" className="mt-0">
        <MatrixScreen />
      </TabsContent>
      <TabsContent value="grants" className="mt-0"><GrantsScreen /></TabsContent>
      <TabsContent value="tree" className="mt-0"><TreeScreen /></TabsContent>
      <TabsContent value="trail" className="mt-0"><TrailScreen /></TabsContent>
    </Tabs>
  );
}
