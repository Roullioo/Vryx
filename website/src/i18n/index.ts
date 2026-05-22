import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'

const resources = {
  fr: {
    common: {
      nav: {
        clients: 'Clients',
        enterprise: 'Enterprise',
        racePool: 'Race-Pool',
        simulator: 'Simulateur',
        comparison: 'Gains solo / pool',
        workers: 'Workers',
        network: 'Network',
        models: 'Modèles IA',
        admin: 'Admin',
        account: 'Mon compte',
      },
      footer: {
        product: 'Produit',
        workers: 'Workers',
        resources: 'Ressources',
        simulate: 'Simuler',
        account: 'Mon compte',
        createAccount: 'Créer un compte',
        rights: '2026 Vryx. Tous droits réservés.',
        language: 'Langue',
      },
    },
    public: {
      pricing: {
        onQuote: 'Sur devis',
        unpublished: 'Tarif non publié — contactez-nous pour un devis.',
      },
      simulator: {
        inference: 'Inférence',
        worker: 'Rentabilité worker',
      },
      models: {
        title: 'Catalogue modèles',
        pricePerMillion: 'Prix public',
      },
    },
    admin: {
      pricing: {
        title: 'Paramètres pricing',
        saved: 'Paramètres pricing sauvegardés.',
      },
      models: {
        title: 'Catalogue modèles',
        saved: 'Modèle sauvegardé.',
      },
    },
  },
  en: {
    common: {
      nav: {
        clients: 'Clients',
        enterprise: 'Enterprise',
        racePool: 'Race-Pool',
        simulator: 'Simulator',
        comparison: 'Solo / pool savings',
        workers: 'Workers',
        network: 'Network',
        models: 'AI models',
        admin: 'Admin',
        account: 'My account',
      },
      footer: {
        product: 'Product',
        workers: 'Workers',
        resources: 'Resources',
        simulate: 'Simulate',
        account: 'My account',
        createAccount: 'Create account',
        rights: '2026 Vryx. All rights reserved.',
        language: 'Language',
      },
    },
    public: {
      pricing: {
        onQuote: 'On quote',
        unpublished: 'Pricing not published — contact us for a quote.',
      },
      simulator: {
        inference: 'Inference',
        worker: 'Worker profitability',
      },
      models: {
        title: 'Model catalog',
        pricePerMillion: 'Public price',
      },
    },
    admin: {
      pricing: {
        title: 'Pricing settings',
        saved: 'Pricing settings saved.',
      },
      models: {
        title: 'Model catalog',
        saved: 'Model saved.',
      },
    },
  },
}

i18n.use(initReactI18next).init({
  resources,
  lng: localStorage.getItem('vryx_lang') || 'fr',
  fallbackLng: 'fr',
  defaultNS: 'common',
  interpolation: {
    escapeValue: false,
  },
})

i18n.on('languageChanged', (lng) => {
  localStorage.setItem('vryx_lang', lng)
})

export default i18n
