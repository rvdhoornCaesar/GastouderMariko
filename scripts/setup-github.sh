#!/usr/bin/env bash
# Zet de GitHub-environments, secrets en variabelen voor de deploy-pipeline.
# Draai dit in Azure Cloud Shell (heeft az en gh), ingelogd op de juiste subscription:
#   gh auth login
#   bash scripts/setup-github.sh
set -euo pipefail

REPO="rvdhoornCaesar/GastouderMariko"
APP_NAME="gastouder-github"
RG_TEST="GastouderMarikoTest"
RG_PROD="GastouderMariko"

SUB_ID=$(az account show --query id -o tsv)
SUB_NAME=$(az account show --query name -o tsv)
TENANT_ID=$(az account show --query tenantId -o tsv)
CLIENT_ID=$(az ad app list --display-name "$APP_NAME" --query "[0].appId" -o tsv)

if [ -z "$CLIENT_ID" ]; then echo "App-registratie '$APP_NAME' niet gevonden."; exit 1; fi
for rg in "$RG_TEST" "$RG_PROD"; do
  az group show -n "$rg" --query name -o tsv > /dev/null || { echo "Resource group $rg niet gevonden in subscription '$SUB_NAME'."; exit 1; }
done

echo "Subscription:  $SUB_NAME ($SUB_ID)"
echo "Repository:    $REPO"
read -r -p "Klopt dit? [j/N] " ok
[ "$ok" = "j" ] || { echo "Afgebroken."; exit 1; }

read -r -p "E-mailadres(sen) voor TEST (komma-gescheiden, jezelf): " TEST_USERS
read -r -p "E-mailadres(sen) voor PRODUCTION (Mariko): " PROD_USERS

gh api -X PUT "repos/$REPO/environments/test" --silent
echo "{\"reviewers\":[{\"type\":\"User\",\"id\":$(gh api user --jq .id)}]}" \
  | gh api -X PUT "repos/$REPO/environments/production" --input - --silent \
  || { echo "Let op: verplichte goedkeurder niet gezet (kan een betaald plan vereisen); environment zonder goedkeuring aangemaakt."; gh api -X PUT "repos/$REPO/environments/production" --silent; }

for env in test production; do
  gh secret set AZURE_CLIENT_ID       --repo "$REPO" --env "$env" --body "$CLIENT_ID"
  gh secret set AZURE_TENANT_ID       --repo "$REPO" --env "$env" --body "$TENANT_ID"
  gh secret set AZURE_SUBSCRIPTION_ID --repo "$REPO" --env "$env" --body "$SUB_ID"
done
gh variable set ALLOWED_USERS        --repo "$REPO" --env test       --body "$TEST_USERS"
gh variable set ALLOWED_USERS        --repo "$REPO" --env production --body "$PROD_USERS"
gh variable set AZURE_RESOURCE_GROUP --repo "$REPO" --env test       --body "$RG_TEST"
gh variable set AZURE_RESOURCE_GROUP --repo "$REPO" --env production --body "$RG_PROD"

echo "Klaar. Je kunt PR #1 nu mergen."
