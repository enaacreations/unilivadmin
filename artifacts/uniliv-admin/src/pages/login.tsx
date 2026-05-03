import { useState } from "react";
import { useLocation } from "wouter";
import { useAuthStore } from "@/lib/store";
import { useLogin } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Eye, EyeOff, Loader2 } from "lucide-react";
import { z } from "zod";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";

const loginSchema = z.object({
  email: z.string().email({ message: "Please enter a valid email address." }),
  password: z.string().min(1, { message: "Password is required." }),
});

export default function Login() {
  const [, setLocation] = useLocation();
  const { setToken } = useAuthStore();
  const loginMutation = useLogin();
  const [showPassword, setShowPassword] = useState(false);
  const [resetEmail, setResetEmail] = useState("");
  const [isResetting, setIsResetting] = useState(false);
  const [isResetOpen, setIsResetOpen] = useState(false);

  const form = useForm<z.infer<typeof loginSchema>>({
    resolver: zodResolver(loginSchema),
    defaultValues: {
      email: "",
      password: "",
    },
  });

  const onSubmit = (values: z.infer<typeof loginSchema>) => {
    loginMutation.mutate({ data: values }, {
      onSuccess: (data) => {
        setToken(data.accessToken);
        setLocation("/");
      }
    });
  };

  const handleResetPassword = () => {
    if (!resetEmail) return;
    setIsResetting(true);
    // Simulate API call
    setTimeout(() => {
      setIsResetting(false);
      setIsResetOpen(false);
      setResetEmail("");
    }, 1000);
  };

  return (
    <div className="min-h-screen w-full flex bg-background">
      {/* Left Panel - Brand */}
      <div className="hidden lg:flex w-1/2 bg-primary text-primary-foreground flex-col justify-between p-12 relative overflow-hidden">
        {/* Subtle background pattern */}
        <div className="absolute inset-0 opacity-[0.03]" style={{ backgroundImage: 'radial-gradient(circle at 2px 2px, white 1px, transparent 0)', backgroundSize: '32px 32px' }}></div>
        
        <div className="relative z-10 flex items-center gap-3">
          <div className="w-10 h-10 rounded bg-accent flex items-center justify-center text-accent-foreground font-display font-bold text-xl shadow-lg">U</div>
          <span className="font-display font-bold text-xl tracking-tight">Uniliv Admin</span>
        </div>

        <div className="relative z-10 max-w-md">
          <h1 className="text-4xl font-display font-bold tracking-tight mb-4 leading-tight">
            The operations command center for co-living
          </h1>
          <p className="text-primary-foreground/70 text-lg">
            Manage residents, track complaints, monitor inventory, and streamline your entire property portfolio from one unified dashboard.
          </p>
        </div>

        <div className="relative z-10 text-sm text-primary-foreground/50">
          &copy; {new Date().getFullYear()} Uniliv Technologies. All rights reserved.
        </div>
      </div>

      {/* Right Panel - Form */}
      <div className="w-full lg:w-1/2 flex items-center justify-center p-8 bg-surface">
        <div className="w-full max-w-md space-y-8">
          <div className="text-center lg:text-left space-y-2">
            <div className="lg:hidden w-12 h-12 rounded bg-accent flex items-center justify-center text-accent-foreground font-display font-bold text-xl shadow-lg mx-auto mb-6">U</div>
            <h2 className="text-3xl font-display font-bold tracking-tight text-primary">Welcome back</h2>
            <p className="text-muted-foreground">Enter your credentials to access the portal</p>
          </div>

          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
              <FormField
                control={form.control}
                name="email"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Email Address</FormLabel>
                    <FormControl>
                      <Input 
                        placeholder="admin@uniliv.com" 
                        {...field} 
                        data-testid="input-email"
                        className="h-11"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              
              <FormField
                control={form.control}
                name="password"
                render={({ field }) => (
                  <FormItem>
                    <div className="flex items-center justify-between">
                      <FormLabel>Password</FormLabel>
                      <Dialog open={isResetOpen} onOpenChange={setIsResetOpen}>
                        <DialogTrigger asChild>
                          <button type="button" className="text-sm font-medium text-accent hover:underline focus:outline-none">
                            Forgot password?
                          </button>
                        </DialogTrigger>
                        <DialogContent>
                          <DialogHeader>
                            <DialogTitle className="font-display">Reset Password</DialogTitle>
                            <DialogDescription>
                              Enter your email address and we'll send you a link to reset your password.
                            </DialogDescription>
                          </DialogHeader>
                          <div className="py-4">
                            <Label htmlFor="reset-email" className="sr-only">Email</Label>
                            <Input 
                              id="reset-email"
                              type="email" 
                              placeholder="name@example.com" 
                              value={resetEmail}
                              onChange={(e) => setResetEmail(e.target.value)}
                            />
                          </div>
                          <DialogFooter>
                            <Button variant="outline" onClick={() => setIsResetOpen(false)}>Cancel</Button>
                            <Button onClick={handleResetPassword} disabled={!resetEmail || isResetting}>
                              {isResetting && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                              Send Reset Link
                            </Button>
                          </DialogFooter>
                        </DialogContent>
                      </Dialog>
                    </div>
                    <FormControl>
                      <div className="relative">
                        <Input 
                          type={showPassword ? "text" : "password"} 
                          placeholder="••••••••" 
                          {...field} 
                          data-testid="input-password"
                          className="h-11 pr-10"
                        />
                        <button
                          type="button"
                          onClick={() => setShowPassword(!showPassword)}
                          className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground focus:outline-none"
                        >
                          {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                        </button>
                      </div>
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <Button 
                type="submit" 
                className="w-full h-11 text-base font-semibold" 
                disabled={loginMutation.isPending}
                data-testid="button-submit-login"
              >
                {loginMutation.isPending ? <Loader2 className="w-5 h-5 animate-spin mr-2" /> : null}
                Sign In
              </Button>
            </form>
          </Form>
        </div>
      </div>
    </div>
  );
}
