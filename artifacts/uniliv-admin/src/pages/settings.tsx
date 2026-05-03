import * as React from "react"
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { User, Bell, Shield, Building } from "lucide-react";

export default function Settings() {
  return (
    <div className="space-y-6">
      <PageHeader 
        title="Configuration" 
        subtitle="Global settings and application preferences"
      />

      <div className="grid gap-6 md:grid-cols-2">
        <Card className="shadow-sm hover:border-primary/20 transition-colors">
          <CardHeader className="flex flex-row items-start gap-4 pb-2">
            <div className="p-3 bg-primary/5 rounded-lg text-primary">
              <User className="w-6 h-6" />
            </div>
            <div>
              <CardTitle className="font-display text-lg">Profile Settings</CardTitle>
              <CardDescription>Manage your personal details and avatar</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="pt-4 border-t mt-4 flex justify-end">
            <Button variant="outline" size="sm">Edit Profile</Button>
          </CardContent>
        </Card>
        
        <Card className="shadow-sm hover:border-primary/20 transition-colors">
          <CardHeader className="flex flex-row items-start gap-4 pb-2">
            <div className="p-3 bg-primary/5 rounded-lg text-primary">
              <Bell className="w-6 h-6" />
            </div>
            <div>
              <CardTitle className="font-display text-lg">Notifications</CardTitle>
              <CardDescription>Configure email and push notification rules</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="pt-4 border-t mt-4 flex justify-end">
            <Button variant="outline" size="sm">Manage Alerts</Button>
          </CardContent>
        </Card>

        <Card className="shadow-sm hover:border-primary/20 transition-colors">
          <CardHeader className="flex flex-row items-start gap-4 pb-2">
            <div className="p-3 bg-primary/5 rounded-lg text-primary">
              <Shield className="w-6 h-6" />
            </div>
            <div>
              <CardTitle className="font-display text-lg">Security</CardTitle>
              <CardDescription>Password requirements and session management</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="pt-4 border-t mt-4 flex justify-end">
            <Button variant="outline" size="sm">Security Policies</Button>
          </CardContent>
        </Card>

        <Card className="shadow-sm hover:border-primary/20 transition-colors">
          <CardHeader className="flex flex-row items-start gap-4 pb-2">
            <div className="p-3 bg-primary/5 rounded-lg text-primary">
              <Building className="w-6 h-6" />
            </div>
            <div>
              <CardTitle className="font-display text-lg">Portfolio Preferences</CardTitle>
              <CardDescription>Default settings across all managed properties</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="pt-4 border-t mt-4 flex justify-end">
            <Button variant="outline" size="sm">Global Config</Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
