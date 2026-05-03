import * as React from "react"
import { UploadCloud, File, X } from "lucide-react"
import { cn } from "@/lib/utils"

interface FileUploadProps extends React.HTMLAttributes<HTMLDivElement> {
  onFileSelect: (file: File | null) => void
  accept?: string
  maxSize?: number // in bytes
  label?: string
  subtext?: string
}

export function FileUpload({
  onFileSelect,
  accept,
  maxSize,
  label = "Click or drag file to this area to upload",
  subtext = "Support for a single upload. Strictly prohibit from uploading company data or other band files",
  className,
  ...props
}: FileUploadProps) {
  const [isDragging, setIsDragging] = React.useState(false)
  const [file, setFile] = React.useState<File | null>(null)
  const fileInputRef = React.useRef<HTMLInputElement>(null)

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(true)
  }

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)
    
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleFileChange(e.dataTransfer.files[0])
    }
  }

  const handleFileChange = (selectedFile: File) => {
    if (maxSize && selectedFile.size > maxSize) {
      alert(`File is too large. Maximum size is ${Math.round(maxSize / 1024 / 1024)}MB`)
      return
    }
    
    setFile(selectedFile)
    onFileSelect(selectedFile)
  }

  const handleRemoveFile = (e: React.MouseEvent) => {
    e.stopPropagation()
    setFile(null)
    onFileSelect(null)
    if (fileInputRef.current) {
      fileInputRef.current.value = ""
    }
  }

  return (
    <div
      className={cn(
        "border-2 border-dashed rounded-lg p-6 flex flex-col items-center justify-center transition-colors cursor-pointer",
        isDragging ? "border-primary bg-primary/5" : "border-border hover:border-primary/50 hover:bg-muted/20",
        className
      )}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onClick={() => !file && fileInputRef.current?.click()}
      {...props}
    >
      <input
        type="file"
        ref={fileInputRef}
        onChange={(e) => e.target.files && handleFileChange(e.target.files[0])}
        accept={accept}
        className="hidden"
      />
      
      {file ? (
        <div className="flex items-center justify-between w-full p-4 bg-background border rounded-md">
          <div className="flex items-center space-x-3 overflow-hidden">
            <div className="p-2 bg-primary/10 rounded-full shrink-0">
              <File className="w-6 h-6 text-primary" />
            </div>
            <div className="overflow-hidden">
              <p className="text-sm font-medium truncate">{file.name}</p>
              <p className="text-xs text-muted-foreground">{(file.size / 1024).toFixed(2)} KB</p>
            </div>
          </div>
          <button
            type="button"
            onClick={handleRemoveFile}
            className="p-2 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-full transition-colors shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      ) : (
        <div className="text-center space-y-4">
          <div className="mx-auto w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center">
            <UploadCloud className="w-6 h-6 text-primary" />
          </div>
          <div>
            <p className="text-sm font-medium text-foreground">{label}</p>
            <p className="text-xs text-muted-foreground mt-1">{subtext}</p>
          </div>
        </div>
      )}
    </div>
  )
}
