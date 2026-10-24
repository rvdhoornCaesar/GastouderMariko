// Gastouder Uren (één omgeving per deployment; draai met environmentName=test en =production): Static Web App Free (frontend + managed functions als backend) + Storage (Table Storage).
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

// Monitoring: Application Insights (workspace-based). Dagelijks plafond op de opslag houdt de kosten rond nul.
resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${prefix}-logs-${suffix}'
  location: location
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
    workspaceCapping: { dailyQuotaGb: json('0.1') }
  }
}

resource insights 'Microsoft.Insights/components@2020-02-02' = {
  name: '${prefix}-ai-${suffix}'
  location: location
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: logs.id
    IngestionMode: 'LogAnalytics'
  }
}

// Free-tier met managed functions (de API uit backend/ draait binnen de Static Web App).
// Upgraden naar een eigen Function App: SKU naar Standard, Function App + linkedBackends toevoegen (zie README).
resource swa 'Microsoft.Web/staticSites@2023-12-01' = {
  name: '${prefix}-web-${suffix}'
  location: location
  sku: { name: 'Free', tier: 'Free' }
  properties: {}
}

resource appSettings 'Microsoft.Web/staticSites/config@2023-12-01' = {
  parent: swa
  name: 'appsettings'
  properties: {
    TABLES_CONNECTION: storageConnection
    ALLOWED_USERS: allowedUsers
    APPLICATIONINSIGHTS_CONNECTION_STRING: insights.properties.ConnectionString
  }
}

output frontendUrl string = 'https://${swa.properties.defaultHostname}'
output staticWebAppName string = swa.name
output appInsightsName string = insights.name
