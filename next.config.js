/** @type {import('next').NextConfig} */
const nextConfig = {
  // Configuración para Electron
  images: {
    unoptimized: true,
  },
  // No usamos output: "export" para mantener compatibilidad con las últimas versiones de Next.js
}

module.exports = nextConfig
