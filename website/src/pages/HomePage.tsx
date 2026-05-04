import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import { HeroSection } from '../components/sections/HeroSection'
import { HomeWorkerPreviewSection } from '../components/sections/HomeWorkerPreviewSection'
import { RacePoolSection } from '../components/sections/RacePoolSection'
import { ClientsSection } from '../components/sections/ClientsSection'
import { WorkersSection } from '../components/sections/WorkersSection'
import { PrivacySection } from '../components/sections/PrivacySection'
import { CTASection } from '../components/sections/CTASection'

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

  return (
    <>
      <HeroSection />
      <HomeWorkerPreviewSection />
      <RacePoolSection />
      <ClientsSection />
      <WorkersSection />
      <PrivacySection />
      <CTASection />
    </>
  )
}
