import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './blackforge/preboot' // BLACKFORGE: idioma y tema del taller antes de i18n
import './i18n' // Initialize i18n
import './blackforge/boot' // BLACKFORGE: identidad y textos de BlackForge Print
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
