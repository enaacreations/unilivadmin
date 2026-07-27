import {
  InputOTP,
  InputOTPGroup,
  InputOTPSlot,
  InputOTPSeparator,
  Label,
} from '@workspace/uniliv-admin';

export function Filled() {
  return (
    <div className="grid gap-1.5">
      <Label>Verification code</Label>
      <InputOTP maxLength={6} value="482913" onChange={() => {}}>
        <InputOTPGroup>
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <InputOTPSlot key={i} index={i} />
          ))}
        </InputOTPGroup>
      </InputOTP>
    </div>
  );
}

export function Partial() {
  return (
    <div className="grid gap-1.5">
      <Label>Enter the 6-digit code</Label>
      <InputOTP maxLength={6} value="48" onChange={() => {}}>
        <InputOTPGroup>
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <InputOTPSlot key={i} index={i} />
          ))}
        </InputOTPGroup>
      </InputOTP>
    </div>
  );
}

export function Grouped() {
  return (
    <div className="grid gap-1.5">
      <Label>Move-in access PIN</Label>
      <InputOTP maxLength={6} value="7391" onChange={() => {}}>
        <InputOTPGroup>
          {[0, 1, 2].map((i) => (
            <InputOTPSlot key={i} index={i} />
          ))}
        </InputOTPGroup>
        <InputOTPSeparator />
        <InputOTPGroup>
          {[3, 4, 5].map((i) => (
            <InputOTPSlot key={i} index={i} />
          ))}
        </InputOTPGroup>
      </InputOTP>
    </div>
  );
}
