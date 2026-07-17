import { Switch, Route, Router as WouterRouter, Redirect, useLocation } from "wouter";
import { QueryClient, QueryClientProvider, QueryCache } from "@tanstack/react-query";
import { handleUnauthorized, redirectToLogin } from "@/lib/api-fetch";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ErrorBoundary } from "@/components/error-boundary";
import NotFound from "@/pages/not-found";
import { Layout, PageGuard } from "@/components/layout";
import Forbidden from "@/pages/forbidden";
import ExecutiveDashboard from "@/pages/executive-dashboard";
import { useAuthStore } from "@/lib/store";

// Pages
import Login from "@/pages/login";
import ResetPasswordPage from "@/pages/reset-password";
import RecoverUsernamePage from "@/pages/recover-username";
import EsignSignPage from "@/pages/esign-sign";
import SharedMenuPage from "@/pages/shared-menu";
import Dashboard from "@/pages/dashboard";
import Properties from "@/pages/properties";
import PropertyDetail from "@/pages/property-detail";
import Rooms from "@/pages/rooms";
import Residents from "@/pages/residents";
import ResidentDetail from "@/pages/resident-detail";
import Complaints from "@/pages/complaints";
import ComplaintDetail from "@/pages/complaint-detail";
import Laundry from "@/pages/laundry";
import Communications from "@/pages/communications";
import Employees from "@/pages/employees";
import EmployeeDetail from "@/pages/employee-detail";
import Attendance from "@/pages/attendance";
import Leaves from "@/pages/leaves";
import Recruitment from "@/pages/recruitment";
import Vendors from "@/pages/vendors";
import VendorDetail from "@/pages/vendor-detail";
import Indents from "@/pages/indents";
import PurchaseOrders from "@/pages/purchase-orders";
import GRN from "@/pages/grn";
import Inventory from "@/pages/inventory";
import Recipes from "@/pages/kitchen";
import MenuPlanning from "@/pages/menu-planning";
import Leads from "@/pages/leads";
import Courses from "@/pages/courses";
import CourseDetail from "@/pages/course-detail";
import SalesDashboard from "@/pages/sales-dashboard";
import PropertyLeads from "@/pages/property-leads";
import Ledger from "@/pages/ledger";
import Payments from "@/pages/payments";
import BillingCycles from "@/pages/billing-cycles";
import Reminders from "@/pages/reminders";
import Banking from "@/pages/banking";
import Expenses from "@/pages/expenses";
import Users from "@/pages/users";
import Settings from "@/pages/settings";
import AuditLog from "@/pages/audit-log";
import AuditAdmin from "@/pages/audits/audit-admin";
import AuditTemplates from "@/pages/audits/templates";
import AuditTemplateDetail from "@/pages/audits/template-detail";
import TemplateBuilder from "@/pages/audits/template-builder";
import TemplatePreview from "@/pages/audits/template-preview";
import QuestionBank from "@/pages/audits/question-bank";
import AuditSchedules from "@/pages/audits/schedules";
import ScheduleForm from "@/pages/audits/schedule-form";
import ScheduleCalendar from "@/pages/audits/schedule-calendar";
import AuditRegister from "@/pages/audits/register";
import NewAudit from "@/pages/audits/new-audit";
import MyAudits from "@/pages/audits/my-audits";
import AuditDetail from "@/pages/audits/audit-detail";
import AuditRunner from "@/pages/audits/audit-runner";
import NcBoard from "@/pages/audits/nc-board";
import NcDetail from "@/pages/audits/nc-detail";
import MyFindings from "@/pages/audits/my-findings";
import ReviewQueue from "@/pages/audits/review-queue";
import ReviewWorkspace from "@/pages/audits/review-workspace";
import AuditReports from "@/pages/audits/reports";
import ReportViewer from "@/pages/audits/report-viewer";
import AuditDashboard from "@/pages/audits/audit-dashboard";
import TrailExplorer from "@/pages/audits/trail-explorer";
import Facility from "@/pages/facility";
import Electricity from "@/pages/electricity";
import ResidentAttendance from "@/pages/resident-attendance";
import IoT from "@/pages/iot";
import Wallet from "@/pages/wallet";
import WalletDetail from "@/pages/wallet-detail";
// Food Ordering & Kitchen Operations
import FoodDashboard from "@/pages/food-dashboard";
import FoodOrders from "@/pages/food-orders";
import FoodKitchenHome from "@/pages/food-kitchen-home";
import FoodKitchenSummary from "@/pages/food-kitchen-summary";
import FoodDispatch from "@/pages/food-dispatch";
import FoodReports from "@/pages/food-reports";
import FoodWasteAnalytics from "@/pages/food-waste-analytics";
import FoodSettings from "@/pages/food-settings";
import FoodOrganization from "@/pages/food-organization";
import FoodMyProperties from "@/pages/food-my-properties";
import UnitLeadHome from "@/pages/unit-lead-home";
import FoodOrderDetail from "@/pages/food-order-detail";
import FoodTrack from "@/pages/food-track";
import FoodGuests from "@/pages/food-guests";
import Masters from "@/pages/masters";
import MasterTable from "@/pages/master-table";
import AppLauncher from "@/pages/apps";

const queryClient = new QueryClient({
  // When any query 401s (expired token), recover once: silently refresh and
  // refetch, or bounce to login. Stops the "empty sidebar after refresh" state.
  queryCache: new QueryCache({
    onError: (error: any) => {
      const status = error?.status ?? error?.response?.status;
      if (status !== 401) return;
      const code = error?.data?.code ?? error?.response?.data?.code;
      if (code === "SESSION_REPLACED") { redirectToLogin("replaced"); return; }
      void handleUnauthorized().then((ok) => { if (ok) queryClient.invalidateQueries(); });
    },
  }),
  defaultOptions: {
    queries: {
      retry: (count, error: any) => {
        const status = error?.status ?? error?.response?.status;
        if (status === 401 || status === 403) return false;
        return count < 1;
      },
      staleTime: 30_000,
    },
  },
});

function ProtectedRoute({ component: Component }: { component: React.ComponentType }) {
  const { isAuthenticated } = useAuthStore();

  if (!isAuthenticated()) {
    return <Redirect to="/login" />;
  }

  return (
    <Layout>
      <PageGuard>
        <Component />
      </PageGuard>
    </Layout>
  );
}

function Router() {
  return (
    <Switch>
      <Route path="/login" component={Login} />
      <Route path="/reset-password/:token" component={ResetPasswordPage} />
      <Route path="/recover-username/:token" component={RecoverUsernamePage} />
      <Route path="/esign/sign/:token" component={EsignSignPage} />
      <Route path="/m/:token" component={SharedMenuPage} />
      {/* Home = the module launcher; the root path is an alias for it. The ops
          overview lives at /dashboard. /apps is deliberately absent from
          PATH_TO_MODULE so every authenticated role can open it. */}
      <Route path="/">{() => <Redirect to="/apps" />}</Route>
      <Route path="/apps">{() => <ProtectedRoute component={AppLauncher} />}</Route>
      <Route path="/dashboard">{() => <ProtectedRoute component={Dashboard} />}</Route>
      <Route path="/home">{() => <ProtectedRoute component={UnitLeadHome} />}</Route>
      <Route path="/properties">{() => <ProtectedRoute component={Properties} />}</Route>
      <Route path="/properties/:id">{() => <ProtectedRoute component={PropertyDetail} />}</Route>
      <Route path="/rooms">{() => <ProtectedRoute component={Rooms} />}</Route>
      <Route path="/residents">{() => <ProtectedRoute component={Residents} />}</Route>
      <Route path="/residents/:id">{() => <ProtectedRoute component={ResidentDetail} />}</Route>
      <Route path="/complaints">{() => <ProtectedRoute component={Complaints} />}</Route>
      <Route path="/complaints/:id">{() => <ProtectedRoute component={ComplaintDetail} />}</Route>
      <Route path="/laundry">{() => <ProtectedRoute component={Laundry} />}</Route>
      <Route path="/communications">{() => <ProtectedRoute component={Communications} />}</Route>
      
      <Route path="/employees">{() => <ProtectedRoute component={Employees} />}</Route>
      <Route path="/employees/:id">{() => <ProtectedRoute component={EmployeeDetail} />}</Route>
      <Route path="/attendance">{() => <ProtectedRoute component={Attendance} />}</Route>
      <Route path="/leaves">{() => <ProtectedRoute component={Leaves} />}</Route>
      <Route path="/recruitment">{() => <ProtectedRoute component={Recruitment} />}</Route>
      
      <Route path="/vendors">{() => <ProtectedRoute component={Vendors} />}</Route>
      <Route path="/vendors/:id">{() => <ProtectedRoute component={VendorDetail} />}</Route>
      <Route path="/indents">{() => <ProtectedRoute component={Indents} />}</Route>
      <Route path="/purchase-orders">{() => <ProtectedRoute component={PurchaseOrders} />}</Route>
      <Route path="/grn">{() => <ProtectedRoute component={GRN} />}</Route>
      <Route path="/inventory">{() => <ProtectedRoute component={Inventory} />}</Route>
      
      <Route path="/recipes">{() => <ProtectedRoute component={Recipes} />}</Route>
      <Route path="/kitchen">{() => <Redirect to="/recipes" />}</Route>
      <Route path="/menu-planning">{() => <ProtectedRoute component={MenuPlanning} />}</Route>

      {/* Food Ordering & Kitchen Operations */}
      <Route path="/food">{() => <Redirect to="/food/dashboard" />}</Route>
      <Route path="/food/dashboard">{() => <ProtectedRoute component={FoodDashboard} />}</Route>
      <Route path="/food/my-properties">{() => <ProtectedRoute component={FoodMyProperties} />}</Route>
      <Route path="/food/organization">{() => <ProtectedRoute component={FoodOrganization} />}</Route>
      <Route path="/food/orders">{() => <ProtectedRoute component={FoodOrders} />}</Route>
      <Route path="/food/orders/:id">{() => <ProtectedRoute component={FoodOrderDetail} />}</Route>
      <Route path="/food/track">{() => <ProtectedRoute component={FoodTrack} />}</Route>
      <Route path="/food/guests">{() => <ProtectedRoute component={FoodGuests} />}</Route>
      <Route path="/food/kitchen-home">{() => <ProtectedRoute component={FoodKitchenHome} />}</Route>
      <Route path="/food/kitchen-summary">{() => <ProtectedRoute component={FoodKitchenSummary} />}</Route>
      <Route path="/food/dispatch">{() => <ProtectedRoute component={FoodDispatch} />}</Route>
      {/* Place Order / Confirm Delivery / Waste moved into Food Overview. */}
      <Route path="/food/reports">{() => <ProtectedRoute component={FoodReports} />}</Route>
      <Route path="/food/waste-analytics">{() => <ProtectedRoute component={FoodWasteAnalytics} />}</Route>
      <Route path="/food/settings">{() => <ProtectedRoute component={FoodSettings} />}</Route>
      
      <Route path="/leads">{() => <ProtectedRoute component={Leads} />}</Route>
      <Route path="/sales/dashboard">{() => <ProtectedRoute component={SalesDashboard} />}</Route>
      <Route path="/property-leads">{() => <ProtectedRoute component={PropertyLeads} />}</Route>
      <Route path="/courses">{() => <ProtectedRoute component={Courses} />}</Route>
      <Route path="/courses/:id">{() => <ProtectedRoute component={CourseDetail} />}</Route>
      
      <Route path="/ledger">{() => <ProtectedRoute component={Ledger} />}</Route>
      <Route path="/payments">{() => <ProtectedRoute component={Payments} />}</Route>
      <Route path="/billing-cycles">{() => <ProtectedRoute component={BillingCycles} />}</Route>
      <Route path="/reminders">{() => <ProtectedRoute component={Reminders} />}</Route>
      <Route path="/banking">{() => <ProtectedRoute component={Banking} />}</Route>
      <Route path="/expenses">{() => <ProtectedRoute component={Expenses} />}</Route>
      <Route path="/facility">{() => <ProtectedRoute component={Facility} />}</Route>
      <Route path="/electricity">{() => <ProtectedRoute component={Electricity} />}</Route>
      <Route path="/resident-attendance">{() => <ProtectedRoute component={ResidentAttendance} />}</Route>
      <Route path="/out-passes">{() => <ProtectedRoute component={ResidentAttendance} />}</Route>
      <Route path="/iot">{() => <ProtectedRoute component={IoT} />}</Route>
      <Route path="/wallet">{() => <ProtectedRoute component={Wallet} />}</Route>
      <Route path="/wallet/:residentId">{() => <ProtectedRoute component={WalletDetail} />}</Route>
      
      {/* Masters — registry-backed reference-data admin (B3-2) */}
      <Route path="/masters">{() => <ProtectedRoute component={Masters} />}</Route>
      <Route path="/masters/:type">{() => <ProtectedRoute component={MasterTable} />}</Route>

      <Route path="/users">{() => <ProtectedRoute component={Users} />}</Route>
      <Route path="/settings">{() => <ProtectedRoute component={Settings} />}</Route>
      <Route path="/audit-log">{() => <ProtectedRoute component={AuditLog} />}</Route>

      {/* Audit & Inspection (FRD v1.2.2) — static routes before /audits/:id */}
      <Route path="/audits/dashboard">{() => <ProtectedRoute component={AuditDashboard} />}</Route>
      <Route path="/audits/my">{() => <ProtectedRoute component={MyAudits} />}</Route>
      <Route path="/audits/findings">{() => <ProtectedRoute component={MyFindings} />}</Route>
      <Route path="/audits/register">{() => <ProtectedRoute component={AuditRegister} />}</Route>
      <Route path="/audits/new">{() => <ProtectedRoute component={NewAudit} />}</Route>
      {/* NC board + finding detail */}
      <Route path="/audits/ncs">{() => <ProtectedRoute component={NcBoard} />}</Route>
      <Route path="/audits/ncs/:id">{() => <ProtectedRoute component={NcDetail} />}</Route>
      {/* Review queue + workspace */}
      <Route path="/audits/review">{() => <ProtectedRoute component={ReviewQueue} />}</Route>
      <Route path="/audits/review/:id">{() => <ProtectedRoute component={ReviewWorkspace} />}</Route>
      {/* Reports registry + viewer */}
      <Route path="/audits/reports">{() => <ProtectedRoute component={AuditReports} />}</Route>
      <Route path="/audits/reports/:reportId">{() => <ProtectedRoute component={ReportViewer} />}</Route>
      {/* Schedules: /new and /calendar must precede the :id edit route */}
      <Route path="/audits/schedules">{() => <ProtectedRoute component={AuditSchedules} />}</Route>
      <Route path="/audits/schedules/new">{() => <ProtectedRoute component={ScheduleForm} />}</Route>
      <Route path="/audits/schedules/calendar">{() => <ProtectedRoute component={ScheduleCalendar} />}</Route>
      <Route path="/audits/schedules/:id">{() => <ProtectedRoute component={ScheduleForm} />}</Route>
      {/* Templates: builder/preview before the :id detail catch-all */}
      <Route path="/audits/templates">{() => <ProtectedRoute component={AuditTemplates} />}</Route>
      <Route path="/audits/templates/:id/versions/:vid/builder">{() => <ProtectedRoute component={TemplateBuilder} />}</Route>
      <Route path="/audits/templates/:id/versions/:vid/preview">{() => <ProtectedRoute component={TemplatePreview} />}</Route>
      <Route path="/audits/templates/:id">{() => <ProtectedRoute component={AuditTemplateDetail} />}</Route>
      <Route path="/audits/question-bank">{() => <ProtectedRoute component={QuestionBank} />}</Route>
      <Route path="/audits/admin">{() => <ProtectedRoute component={AuditAdmin} />}</Route>
      <Route path="/audits/trail">{() => <ProtectedRoute component={TrailExplorer} />}</Route>
      {/* Runner must precede the :id catch-all (wouter matches in Switch order) */}
      <Route path="/audits/:id/run">{() => <ProtectedRoute component={AuditRunner} />}</Route>
      <Route path="/audits/:id">{() => <ProtectedRoute component={AuditDetail} />}</Route>
      <Route path="/dashboard/executive">{() => <ProtectedRoute component={ExecutiveDashboard} />}</Route>
      <Route path="/403">{() => <ProtectedRoute component={Forbidden} />}</Route>
      
      <Route component={NotFound} />
    </Switch>
  );
}

// Wraps the routed tree in the app-level ErrorBoundary. Lives inside
// WouterRouter so it can read the current location and reset the boundary on
// navigation — letting a user escape a crashed page via the sidebar without a
// full reload. A render error in any page falls back to the branded screen.
function RoutedApp() {
  const [location] = useLocation();
  return (
    <ErrorBoundary resetKey={location}>
      <Router />
    </ErrorBoundary>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL?.replace(/\/$/, "") || ""}>
          <RoutedApp />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
