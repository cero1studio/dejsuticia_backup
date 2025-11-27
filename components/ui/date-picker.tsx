"use client"
import DatePicker from "react-datepicker"
import "react-datepicker/dist/react-datepicker.css"
import { Button } from "@/components/ui/button"
import { Calendar } from "lucide-react"
import { cn } from "@/lib/utils"

interface DatePickerProps {
  date: Date | null
  setDate: (date: Date | null) => void
  className?: string
  placeholder?: string
}

export function DatePickerComponent({ date, setDate, className, placeholder = "Seleccionar fecha" }: DatePickerProps) {
  return (
    <div className={cn("relative", className)}>
      <DatePicker
        selected={date}
        onChange={setDate}
        dateFormat="dd/MM/yyyy"
        className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
        placeholderText={placeholder}
        showPopperArrow={false}
        customInput={
          <div className="flex items-center">
            <input
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
              placeholder={placeholder}
              value={date ? date.toLocaleDateString() : ""}
              readOnly
            />
            <Button type="button" variant="ghost" size="icon" className="absolute right-0 top-0 h-full">
              <Calendar className="h-4 w-4" />
            </Button>
          </div>
        }
      />
    </div>
  )
}
