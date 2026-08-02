import * as React from "react"
import { Avatar, AvatarFallback as RadixAvatarFallback, AvatarImage } from "@/components/ui/avatar"

interface UserAvatarProps extends React.ComponentPropsWithoutRef<typeof Avatar> {
  name?: string
  src?: string
  fallbackClassName?: string
}

export function UserAvatar({ name, src, className, fallbackClassName, ...props }: UserAvatarProps) {
  const initials = React.useMemo(() => {
    if (!name) return "U"
    const parts = name.split(" ")
    if (parts.length >= 2) {
      return `${parts[0][0]}${parts[1][0]}`.toUpperCase()
    }
    return name.substring(0, 2).toUpperCase()
  }, [name])

  return (
    <Avatar className={className} {...props}>
      {src && <AvatarImage src={src} alt={name || "User avatar"} />}
      <RadixAvatarFallback className={`bg-primary/10 text-primary font-medium ${fallbackClassName || ""}`}>
        {initials}
      </RadixAvatarFallback>
    </Avatar>
  )
}
