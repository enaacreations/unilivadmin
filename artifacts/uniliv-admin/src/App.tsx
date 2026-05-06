import { Switch, Route, Router as WouterRouter, Redirect } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import { Layout, PageGuard } from "@/components/layout";
import Forbidden from "@/pages/forbidden";
import ExecutiveDashboard from "@/pages/executive-dashboard";
import { useAuthStore } from "@/lib/store";

// Pages
import Login from "@/pages/login";
import EsignSignPage from "@/pages/esign-sign";
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
import Kitchen from "@/pages/kitchen";
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
import Facility from "@/pages/facility";
import Electricity from "@/pages/electricity";
import ResidentAttendance from "@/pages/resident-attendance";
import IoT from "@/pages/iot";
import Wallet from "@/pages/wallet";
import WalletDetail from "@/pages/wallet-detail";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
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
      <Route path="/esign/sign/:token" component={EsignSignPage} />
      <Route path="/">{() => <ProtectedRoute component={Dashboard} />}</Route>
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
      
      <Route path="/recipes">{() => <ProtectedRoute component={Kitchen} />}</Route>
      <Route path="/kitchen">{() => <Redirect to="/recipes" />}</Route>
      <Route path="/menu-planning">{() => <ProtectedRoute component={MenuPlanning} />}</Route>
      
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
      
      <Route path="/users">{() => <ProtectedRoute component={Users} />}</Route>
      <Route path="/settings">{() => <ProtectedRoute component={Settings} />}</Route>
      <Route path="/dashboard/executive">{() => <ProtectedRoute component={ExecutiveDashboard} />}</Route>
      <Route path="/403">{() => <ProtectedRoute component={Forbidden} />}</Route>
      
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL?.replace(/\/$/, "") || ""}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
