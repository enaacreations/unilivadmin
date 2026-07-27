import { FileUpload } from '@workspace/uniliv-admin';

export function Default() {
  return (
    <div className="w-96">
      <FileUpload onFileSelect={() => {}} />
    </div>
  );
}

export function AuditEvidence() {
  return (
    <div className="w-96">
      <FileUpload
        onFileSelect={() => {}}
        accept="image/png,image/jpeg,application/pdf"
        label="Upload audit evidence"
        subtext="PNG, JPG or PDF up to 10 MB. Attach photos of the inspected area."
      />
    </div>
  );
}
