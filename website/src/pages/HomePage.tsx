import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import { VryxLandingExperience } from '../components/sections/VryxLandingExperience'

export function HomePage() {
  const { hash, pathname } = useLocation()

  useEffect(() => {
    if (pathname !== '/' || !hash) return
    const id = hash.replace('#', '')
    const el = document.getElementById(id)
    if (el) {
      window.requestAnimationFrame(() => {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' })
      })
    }
  }, [hash, pathname])

  return <VryxLandingExperience />
}
