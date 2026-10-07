import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import { brandAssets } from '@solventa/assets/web'

const favicon = document.createElement('link')
favicon.rel = 'icon'
favicon.type = 'image/svg+xml'
favicon.href = brandAssets.icon.green
document.head.append(favicon)

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
