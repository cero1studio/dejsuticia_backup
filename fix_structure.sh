#!/bin/bash

# Crear archivo temporal
temp_file=$(mktemp)

# Usar awk para corregir la estructura
awk '
BEGIN { 
    in_scanbackup = 0
    in_try_block = 0
    finalization_added = 0
}

/async scanBackup/ { 
    in_scanbackup = 1
    print
    next
}

in_scanbackup && /^[[:space:]]*try[[:space:]]*{/ {
    in_try_block = 1
    print
    next
}

in_scanbackup && in_try_block && /^[[:space:]]*} catch/ {
    if (!finalization_added) {
        print "      // Finalizar escaneo con datos consolidados"
        print "      this.totalFilesToDownload = this.scannedFiles.length;"
        print "      // Guardar los stats escaneados"
        print "      this.scannedStats = { ...this.backupStats };"
        print "      // Finalizar escaneo"
        print "      const totalBytes = this.backupStats.backupSize * 1024 * 1024 * 1024;"
        print "      this.addLog(\"success\", `Escaneo de respaldo completado. Tamaño total: ${totalBytes} bytes (${this.backupStats.backupSize.toFixed(2)} GB)`);"
        print "      this.addLog(\"info\", `Organizaciones: ${this.backupCounts.organizations}`);"
        print "      this.addLog(\"info\", `Espacios de trabajo: ${this.backupCounts.workspaces}`);"
        print "      this.addLog(\"info\", `Aplicaciones: ${this.backupCounts.applications}`);"
        print "      this.addLog(\"info\", `Elementos: ${this.backupCounts.items}`);"
        print "      this.addLog(\"info\", `Archivos encontrados: ${this.backupCounts.files}`);"
        print "      this.addLog(\"info\", `Tamaño estimado: ${this.backupStats.backupSize.toFixed(2)} GB`);"
        print "      await this.updateEstimatedSizeInBackupRecord();"
        print "      // ACTUALIZAR EL ITEM DE BACKUP EN PODIO CON LOS DATOS DEL ESCANEO"
        print "      await this.updateBackupRecord(false);"
        print "      if (progressCallback) {"
        print "        this.updateProgress(99, \"Escaneo completado. Listo para descargar.\", progressCallback);"
        print "      }"
        finalization_added = 1
    }
    in_try_block = 0
    print
    next
}

in_scanbackup && /^[[:space:]]*}[[:space:]]*$/ && !in_try_block {
    in_scanbackup = 0
    print
    next
}

/^[[:space:]]*\/\/ Finalizar escaneo con datos consolidados/ {
    # Saltar las líneas duplicadas que están fuera del try
    skip_lines = 19
    next
}

skip_lines > 0 { 
    skip_lines--; 
    next; 
}

{ print; }
' lib/podio-service.ts > "$temp_file"

# Reemplazar el archivo original
mv "$temp_file" lib/podio-service.ts

echo "Estructura corregida"
