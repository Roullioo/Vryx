const { build } = require('./package.json')

const env = process.env
const azureReady =
  env.VRYX_AZURE_TRUSTED_SIGNING_ENDPOINT &&
  env.VRYX_AZURE_TRUSTED_SIGNING_ACCOUNT &&
  env.VRYX_AZURE_TRUSTED_SIGNING_PROFILE &&
  env.VRYX_AZURE_TRUSTED_SIGNING_PUBLISHER

const signedConfig = {
  ...build,
  forceCodeSigning: true,
  win: {
    ...build.win,
    ...(azureReady
      ? {
          azureSignOptions: {
            endpoint: env.VRYX_AZURE_TRUSTED_SIGNING_ENDPOINT,
            codeSigningAccountName: env.VRYX_AZURE_TRUSTED_SIGNING_ACCOUNT,
            certificateProfileName: env.VRYX_AZURE_TRUSTED_SIGNING_PROFILE,
            publisherName: env.VRYX_AZURE_TRUSTED_SIGNING_PUBLISHER,
            fileDigest: 'SHA256',
            timestampDigest: 'SHA256',
            timestampRfc3161: 'http://timestamp.acs.microsoft.com',
          },
        }
      : {}),
  },
}

module.exports = signedConfig
