import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'

const resources = {
  fr: {
    common: {
      nav: {
        clients: 'Clients',
        enterprise: 'Entreprise',
        racePool: 'Groupe de calcul',
        simulator: 'Simulateur',
        comparison: 'Gains seul / collectif',
        workers: 'Nœuds',
        network: 'Réseau',
        models: 'Modèles IA',
        admin: 'Admin',
        account: 'Mon compte',
      },
      footer: {
        product: 'Produit',
        workers: 'Nœuds',
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
        worker: 'Rentabilité nœud',
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
        enterprise: 'Entreprise',
        racePool: 'Groupe de calcul',
        simulator: 'Simulateur',
        comparison: 'Gains seul / collectif',
        workers: 'Nœuds',
        network: 'Réseau',
        models: 'Modèles IA',
        admin: 'Admin',
        account: 'Mon compte',
      },
      footer: {
        product: 'Produit',
        workers: 'Nœuds',
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
        worker: 'Rentabilité nœud',
      },
      models: {
        title: 'Catalogue modèles',
        pricePerMillion: 'Prix public',
      },
    },
    admin: {
      pricing: {
        title: 'Paramètres de tarification',
        saved: 'Paramètres de tarification sauvegardés.',
      },
      models: {
        title: 'Catalogue modèles',
        saved: 'Modèle sauvegardé.',
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
