"use client"

import { useState } from "react"
import { DatePickerComponent } from "@/components/ui/date-picker"
import { Button } from "@/components/ui/button"
import { Search, X } from "lucide-react"

export function BackupDateFilter({ onFilter }: { onFilter: (startDate: Date | null, endDate: Date | null) => void }) {
  const [startDate, setStartDate] = useState<Date | null>(null)
  const [endDate, setEndDate] = useState<Date | null>(null)

  const handleFilter = () => {
    onFilter(startDate, endDate)
  }

  const handleClear = () => {
    setStartDate(null)
    setEndDate(null)
    onFilter(null, null)
  }

  return (
    <div className="space-y-4 p-4 bg-gray-50 rounded-lg">
      <h3 className="font-medium">Filtrar por fecha</h3>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className="text-sm text-gray-500 mb-1 block">Fecha inicio</label>
          <DatePickerComponent date={startDate} setDate={setStartDate} placeholder="Fecha inicio" />
        </div>
        <div>
          <label className="text-sm text-gray-500 mb-1 block">Fecha fin</label>
          <DatePickerComponent date={endDate} setDate={setEndDate} placeholder="Fecha fin" />
        </div>
      </div>
      <div className="flex gap-2">
        <Button onClick={handleFilter} className="flex-1">
          <Search className="mr-2 h-4 w-4" />
          Filtrar
        </Button>
        <Button variant="outline" onClick={handleClear}>
          <X className="mr-2 h-4 w-4" />
          Limpiar
        </Button>
      </div>
    </div>
  )
}
