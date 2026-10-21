// Gastouder Uren (één omgeving per deployment; draai met environmentName=test en =production): Static Web App (frontend) + Function App op Consumption (backend) + Storage (Table Storage).
@description('Basisnaam voor alle resources (kleine letters/cijfers, 3-14 tekens).')
@minLength(3)
@maxLength(14)
param baseName string = 'gastouder'

@description('Omgeving: test of production. Elke omgeving krijgt eigen resources.')
@allowed(['test', 'production'])
param environmentName string = 'test'

@description('Regio. Static Web Apps ondersteunt maar enkele regio\'s, o.a. westeurope.')
param location string = 'westeurope'

@description('Komma-gescheiden e-mailadressen (Microsoft-account) die de app mogen gebruiken.')
param allowedUsers string

var envShort = environmentName == 'production' ? 'prd' : 'tst'
var prefix = '${baseName}-${envShort}'
var suffix = uniqueString(resourceGroup().id)
var storageName = take('${baseName}${envShort}${suffix}', 24)

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageName
  location: location
  sku: { name: 'Standard_LRS' }
  kind: 'StorageV2'
  properties: {
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    supportsHttpsTrafficOnly: true
  }
}

var storageConnection = 'DefaultEndpointsProtocol=https;AccountName=${storage.name};AccountKey=${storage.listKeys().keys[0].value};EndpointSuffix=${environment().suffixes.storage}'

resource plan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: '${prefix}-plan'
  location: location
  kind: 'linux'
  sku: { name: 'Y1', tier: 'Dynamic' }
  properties: { reserved: true }
}

resource func 'Microsoft.Web/sites@2023-12-01' = {
  name: '${prefix}-api-${suffix}'
  location: location
  kind: 'functionapp,linux'
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    siteConfig: {
      linuxFxVersion: 'NODE|20'
      minTlsVersion: '1.2'
      ftpsState: 'Disabled'
      appSettings: [
        { name: 'AzureWebJobsStorage', value: storageConnection }
        { name: 'WEBSITE_CONTENTAZUREFILECONNECTIONSTRING', value: storageConnection }
        { name: 'WEBSITE_CONTENTSHARE', value: toLower('${prefix}-api') }
        { name: 'FUNCTIONS_EXTENSION_VERSION', value: '~4' }
        { name: 'FUNCTIONS_WORKER_RUNTIME', value: 'node' }
        { name: 'WEBSITE_NODE_DEFAULT_VERSION', value: '~20' }
        { name: 'ALLOWED_USERS', value: allowedUsers }
      ]
    }
  }
}

// Standard-tier is nodig om een eigen Function App aan een Static Web App te koppelen.
resource swa 'Microsoft.Web/staticSites@2023-12-01' = {
  name: '${prefix}-web-${suffix}'
  location: location
  sku: { name: 'Standard', tier: 'Standard' }
  properties: {}
}

resource link 'Microsoft.Web/staticSites/linkedBackends@2023-12-01' = {
  parent: swa
  name: 'backend'
  properties: {
    backendResourceId: func.id
    region: location
  }
}

output frontendUrl string = 'https://${swa.properties.defaultHostname}'
output functionAppName string = func.name
output staticWebAppName string = swa.name
