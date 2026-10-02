# LedgerLens — statistiques Kraken, dans le navigateur

Site statique en français pour importer un **export Kraken Spot Ledgers CSV avec valeurs USD**. Aucun framework, dépendance, backend, compte, cookie ni télémétrie.

## Utilisation

1. Dans Kraken, exportez les **Ledgers**, avec tout l'historique disponible et les colonnes de valorisation USD. Un export Trades seul ne suffit pas.
2. Choisissez le CSV ou glissez-le dans la zone d'import.
3. Consultez la valeur du portefeuille, le gain non réalisé global et par actif, les gains réalisés et la répartition. **Tous les actifs sont affichés par défaut, y compris ceux à solde nul**, comme un BTC entièrement sorti du compte. Décochez **Inclure les soldes nuls** pour ne voir que les actifs détenus. Dépliez **Statistiques détaillées par actif** pour le coût moyen, les récompenses, frais, achats et ventes de chaque crypto (mêmes filtres que le tableau principal).
4. Vérifiez les avertissements et les coûts inconnus. Renseignez si nécessaire un coût unitaire estimé pour les apports sans historique.
5. Choisissez USD ou EUR pour l'affichage, modifiez les prix par actif dans cette devise ou choisissez **Source des prix → Kraken / CoinGecko** puis **Actualiser les cours**. Cette action contacte uniquement l'API publique sélectionnée, sans transmettre votre fichier, vos quantités ou vos transactions. Aucun appel externe n'est effectué à l'ouverture ou lors de l'import.
6. Exportez les statistiques en CSV si vous voulez les conserver. Recharger la page ou cliquer sur **Effacer** supprime l'import et les hypothèses de la page.

Le bouton d'exemple utilise uniquement des données fictives. Le CSV personnel présent dans le dossier de travail **n'est pas intégré au site**.

## Graphique en bougies et achats/ventes

La section **Cours & vos transactions** permet de sélectionner n'importe quelle crypto de l'import, y compris un actif entièrement vendu, et les périodes **1W, 1M, 3M, 6M, 1Y, ALL**. Les actifs sont triés alphabétiquement dans deux groupes (détenus et à solde nul). Cliquer sur le nom d'une crypto dans le tableau ouvre directement son graphique. La fin de période peut être la fin de l'historique importé (par défaut) ou aujourd'hui. Les mois sont calendaires ; **ALL** couvre la période du fichier, pas automatiquement toute la vie du marché.

- À l'import, le graphique reste **local** : une courbe relie les prix implicites présents dans le fichier. Ce sont des observations ponctuelles, pas un historique de marché continu et pas des bougies fabriquées. Aucun appel réseau automatique.
- Cliquez sur **Charger les bougies Kraken** pour obtenir de véritables OHLC de la paire USD active, depuis l'API publique. Ensuite, changer d'actif ou de période recharge les données nécessaires ; cliquer à nouveau force l'actualisation. **Observations du fichier** revient au mode local et annule la requête en cours. Les cours du graphique ne modifient jamais les prix ni les coûts du tableau de bord.
- Résolutions : `1W` = 1 heure, `1M`/`3M` = 4 heures, `6M`/`1Y` = 1 jour, `ALL` = 1 semaine (15 jours pour un historique de plus de 710 semaines). Kraken ne retourne que les **720 bougies les plus récentes** pour chaque résolution : les données plus anciennes ne sont pas récupérables en paginant `since`. Un actif récent, disparu, sans paire USD ou une plage ancienne peut ne pas être couvert. La couverture et les opérations sans bougie sont signalées, sans déplacer les opérations à une autre date ni inventer de cours.
- Les achats sont marqués par une flèche verte sous la bougie, les ventes par une flèche rouge au-dessus. Les conversions crypto/crypto et de poussières sont incluses ; dépôts, retraits, transferts Earn et récompenses ne sont pas marqués comme achats/ventes. Les lignes d'un même échange sont regroupées par `refid` et actif/sens ; plusieurs échanges de même sens dans une bougie sont regroupés visuellement avec leur nombre.
- La position verticale d'une flèche sur une bougie est un **repère visuel**, pas le prix d'exécution. Dans la courbe locale, le repère utilise le prix implicite USD des lignes de l'actif ; si ce prix est absent, l'opération figure seulement dans le tableau. Le prix implicite du ledger n'est pas forcément le prix payé/reçu après spread et frais.
- Survolez ou touchez le graphique pour lire ouverture/haut/bas/clôture/volume. Au clavier, utilisez les flèches gauche/droite et Home/End sur le graphique ; les repères sont aussi accessibles au clavier. Dépliez **Achats et ventes de la période** pour toutes les dates, quantités brutes, frais crypto, prix implicites et références, y compris les opérations sans bougie.
- Les heures sont UTC. La dernière bougie renvoyée par Kraken est **en cours**, rendue translucide et signalée. Une bougie qui chevauche la date de fin de la période inclut la totalité de ses échanges, pas un OHLC recalculé à l'heure exacte de fin. Les trous ne sont pas comblés.
- Seuls le symbole de paire, l'intervalle et `since` sont envoyés à Kraken ; aucun historique privé, solde ni clé API. Les réponses OHLC sont gardées une minute en mémoire pour éviter les requêtes répétées. Le graphique fonctionne sur GitHub Pages, sans connecteur privé.

Source : [limites et format OHLC Kraken](https://docs.kraken.com/api/docs/rest-api/get-ohlc-data/).

### Source CoinGecko : courbe et repères locaux

CoinGecko peut aussi valoriser le portefeuille : choisissez **Source des prix → CoinGecko** dans la vue d'ensemble, vérifiez les **Identifiants CoinGecko pour la valorisation**, puis cliquez sur **Actualiser les cours**. Les identifiants sont partagés avec le graphique. Les actifs non préconfigurés nécessitent un identifiant explicite ; aucun token n'est choisi automatiquement à partir d'un symbole ambigu. Le catalogue contrôle la concordance ID/symbole, sans garantir à lui seul l'identité d'un token.

L'endpoint public `simple/price` charge les prix USD de tous les actifs identifiés en une requête, avec `include_last_updated_at=true`. La date renvoyée par CoinGecko, et non l'heure du clic, accompagne chaque prix dans le détail du PnL et l'export. Les prix agrégés ne sont pas des prix d'exécution Kraken. Les coûts historiques et quantités ne changent pas ; valeur, allocation et gain non réalisé sont recalculés, puis convertis dans la devise d'affichage. Les prix absents, invalides ou sans date sont signalés et les anciens prix conservés. Un ID explicite invalide ou un échec réseau bloque l'actualisation sans remplacement silencieux par Kraken. Les limites publiques/CORS/429 s'appliquent aussi à cette fonction.

Dans **Source**, choisissez **CoinGecko · courbe**, puis **Charger la courbe CoinGecko**. Le site utilise l'API publique `api.coingecko.com/api/v3` (`coins/list` et `coins/{id}/market_chart`) et dessine lui-même les prix avec les achats/ventes du ledger. Il ne modifie pas un widget CoinGecko et ne fabrique pas de bougies : Kraken reste disponible pour les OHLC.

- L'identifiant exact (`bitcoin` pour BTC, `ethereum` pour ETH, etc.) est contrôlé contre le catalogue. Quelques identifiants usuels sont proposés ; sinon saisissez celui de la crypto sur CoinGecko. Le site ne choisit pas arbitrairement le premier token portant un symbole identique. Même un symbole concordant ne dispense pas de vérifier l'actif exact.
- Chaque achat/vente est placé à sa **date exacte** sur la courbe, avec un cours de marché interpolé entre deux points proches (au maximum trois pas horaires ou quotidiens). Ce repère n'est pas un prix d'exécution Kraken. Les trous importants coupent la courbe et les opérations non couvertes restent dans le tableau, sans extrapolation.
- Les limites de période entre deux échantillons proches sont également interpolées pour découper la courbe exactement et conserver les repères de bord. Ces points sont identifiés au survol et ne sont pas comptés comme des échantillons reçus.
- L'accès public/Demo fournit au maximum **365 jours** récents. Les périodes `ALL` ou anciennes peuvent donc être tronquées ; la couverture et les opérations exclues sont affichées. Le nombre de points et leur fréquence dépendent de CoinGecko (horaire ou quotidien), pas de la résolution des bougies Kraken.
- Les périodes demandant plus de 90 jours partagent la série quotidienne de 365 jours, filtrée ensuite à la période sélectionnée et mise en cache une minute. Cela limite les appels et ne permet pas de récupérer les années antérieures.
- Aucun historique, quantité, prix de transaction ou identifiant Kraken n'est envoyé à CoinGecko : seulement l'identifiant public de l'actif, USD et le nombre de jours demandé. Les repères sont calculés dans le navigateur. Aucun proxy public ni clé Pro n'est ajouté.
- L'accès sans clé a été vérifié, mais il n'est pas garanti : restrictions navigateur/CORS, refus d'accès et limite de requêtes `429` sont signalés. Le site ne remplace pas silencieusement un échec par une autre source. Retournez aux observations locales ou aux bougies Kraken.
- Les prix du graphique ne modifient pas la valorisation ni le PnL du tableau de bord. L'affichage EUR convertit les points USD au même taux visible. Une attribution CoinGecko accompagne la courbe.

Documentation : [historique Demo et limite de 365 jours](https://docs.coingecko.com/demo/reference/coins-id-market-chart), [identifiants des actifs](https://docs.coingecko.com/reference/coins-list).

## Devise d'affichage : USD ou EUR

Le sélecteur **Devise d'affichage** permet de passer du dollar à l'euro, pour les deux imports CSV/API. Choisir **EUR** charge explicitement le dernier échange de la paire publique Kraken **EUR/USD** : `EUR par USD = 1 / USD par EUR`. Aucun fichier, quantité ou identifiant n'est envoyé. L'affichage initial reste USD sans requête automatique.

- Le taux et sa date UTC sont visibles ; **Actualiser le taux EUR/USD** permet de le renouveler. Les valeurs, coûts, gains réalisés/non réalisés, récompenses, frais, historique et graphiques utilisent tous le même taux. Les quantités crypto et pourcentages restent inchangés.
- Les champs de prix et de coût estimé utilisent la devise affichée ; une saisie EUR est reconvertie en USD au taux indiqué. Changer de devise ne réécrit pas les opérations ni les coûts USD enregistrés en mémoire.
- Les graphiques restent basés sur des OHLC **USD** ; les prix affichés sont convertis en EUR au taux unique, pas des bougies de marché EUR historiques. La forme du graphique ne change pas.
- Une erreur de change conserve explicitement la devise et les valeurs précédentes ; aucun taux de 1 ou montant fictif ne remplace un taux absent.
- L'export conserve ses colonnes de calcul USD et ajoute la devise choisie, le taux, sa source/date et les montants d'affichage correspondants.
- **Conversion de présentation, pas recalcul de performance historique en EUR ni fiscalité.** Calculer un véritable gain en EUR demanderait les taux USD/EUR de chaque achat, vente et distribution, qui ne sont pas fournis par ce ledger. Les anciennes valorisations du CSV restent anciennes, même après conversion.

## BTC et capital Hybrid Earn / DeFi

Un solde Spot nul ne prouve pas l'absence de BTC dans un coffre. Certains exports montrent des sorties négatives `hybridearnwithdrawal` depuis Spot, sans ligne de solde du produit destinataire. Les traiter comme de simples sorties du portefeuille masque le capital transféré et retire son coût.

La case **Inclure le capital Hybrid Earn / DeFi reconstitué**, activée par défaut, suit un compartiment distinct : une sortie négative `hybridearnwithdrawal` y déplace les unités sans retirer leur coût global ; un retour positif `hybridearndeposit` réduit ce compartiment sans créer un nouvel achat. Les frais diminuent les unités. Les mouvements appariés déjà équilibrés restent neutres et ne sont pas ajoutés une deuxième fois. Un retour supérieur au capital visible est un apport de référence inconnue, pas automatiquement une récompense.

- La quantité affiche **ledger/API + Hybrid reconstitué**, y compris pour BTC ; les coûts et gains suivent ce périmètre. Les positions sont incluses dans l'allocation, les cours, le graphique et l'export.
- **Ce n'est pas le solde actuel confirmé du coffre** : le ledger Spot ne donne pas son rendement, ses pertes ni ses mouvements hors de l'export. Les totaux sont marqués reconstitués et la qualité indique « Hybrid à confirmer ». Comparez avec le solde du coffre dans Kraken.
- L'API `Balance` rapproche uniquement les quantités qu'elle renvoie ; le capital Hybrid est ajouté séparément. Si votre réponse API inclut déjà ce produit, **décochez la reconstitution pour éviter un double comptage**. La documentation de l'API Spot Earn ne suffit pas à garantir que le coffre DeFi figure dans `Balance`.
- Décochez pour retrouver strictement le périmètre du ledger/solde API. La reconstitution ne s'applique pas aux retraits ordinaires ni aux transferts génériques.

Références : [API Spot Earn](https://docs.kraken.com/exchange/guides/rest/earn), [Balance API](https://docs.kraken.com/api/docs/rest-api/get-account-balance/), [risques et fonctionnement Bitcoin Vault](https://support.kraken.com/articles/bitcoin-vault). Ces pages ne documentent pas explicitement les deux libellés Hybrid du CSV ; la reconstitution s'appuie sur leur signe et leurs mouvements, avec cette limite affichée, et ne remplace pas un rapprochement avec le coffre.

## Connexion Kraken API (facultative)

L'import CSV reste entièrement statique. L'API privée Kraken nécessite une signature avec une **clé publique + un secret**, et ne fournit pas de CORS permettant son utilisation directe depuis GitHub Pages. Le mode API nécessite donc le connecteur local fourni, sans dépendances :

```sh
npm run connect
```

Ouvrez <http://127.0.0.1:4173>, dépliez **Ou connecter Kraken**, puis saisissez une clé dédiée. Si `npm start` occupe déjà ce port, arrêtez ce serveur avant de lancer le connecteur, ou utilisez un autre port (`PORT=4174 npm run connect`).

### Autorisations nécessaires

Dans la création de clé Kraken, activez **uniquement** :

- **Data → Query ledger entries**, pour lire tout l'historique paginé.
- **Funds → Query funds**, pour lire les soldes et rapprocher les quantités.

Ni **Query closed orders & trades** (non utilisé par cette version), ni autorisation d'achat/vente, retrait, dépôt, transfert, modification d'ordres ou Earn ne sont nécessaires. Si une 2FA spécifique à l'API est configurée, fournissez son code dans le champ facultatif. Ce n'est pas nécessairement la 2FA de connexion au compte. Utilisez une clé dédiée afin d'éviter les conflits de nonce avec d'autres applications. Vous pouvez la révoquer après l'import et lui attribuer une expiration.

Les identifiants passent uniquement du navigateur à **votre connecteur loopback** (`127.0.0.1`/`localhost`). Le secret sert à signer les requêtes, **il n'est pas envoyé à Kraken** ; Kraken reçoit la clé publique et la signature. Le connecteur ne les journalise jamais et ne les écrit pas sur disque. Par défaut, le navigateur ne les enregistre pas non plus. Les champs sont effacés lors de l'envoi ou en cas d'erreur. Les identifiants existent temporairement en mémoire pendant la synchronisation ; l'effacement physique de la mémoire JavaScript n'est pas garanti. N'entrez vos clés que dans votre propre copie de confiance de ce site. Aucune clé ne doit être incluse dans Git, GitHub Actions ou un fichier public.

### Mémoriser la clé sur cet appareil

La case **Mémoriser la clé sur cet appareil** est décochée par défaut. Si vous la cochez, **après un import API réussi**, la clé publique et le secret sont chiffrés en AES-GCM avec une clé Web Crypto non exportable, puis enregistrés dans IndexedDB. Le code 2FA, les opérations et les soldes ne sont jamais mémorisés. Au prochain chargement, les champs sont restaurés ; le bouton **Réutiliser la clé mémorisée** permet de les remplir à nouveau après un import.

Le bouton **Oublier la clé mémorisée**, ou décocher la case, supprime la copie persistante et efface les champs. Cela ne révoque pas la clé sur Kraken. **Effacer** dans le tableau de bord n'efface que les données du portefeuille, pas une clé dont vous avez choisi la mémorisation. Pour la révoquer, utilisez Kraken.

Ce n'est pas le cache HTTP mais le stockage du profil navigateur, séparé **par origine** : localhost, 127.0.0.1 et GitHub Pages ne partagent pas leurs copies. Le chiffrement ne protège pas contre un script malveillant de la même origine, une extension privilégiée ou quelqu'un ayant accès au profil : ces acteurs peuvent utiliser la clé de déchiffrement. Les dépôts GitHub Pages du même compte partagent leur origine. Réservez cette option à un appareil personnel et une origine de confiance. Effacer les données du site dans le navigateur supprime aussi la copie. Si IndexedDB/Web Crypto sont indisponibles, la mémorisation échoue explicitement ; aucun repli en texte clair n'est utilisé.

Le connecteur n'accepte que deux endpoints privés fixes en lecture : `Ledgers` et `Balance`. Il écoute uniquement sur loopback, refuse les origines non autorisées et refuse toute commande de trading ou retrait. Pagination complète à 50 lignes, appels espacés pour respecter les limites API, limite explicite de 10 000 écritures. Au-delà, utilisez un CSV. Une erreur, annulation ou pagination incohérente interrompt l'import sans remplacer le précédent par un historique tronqué. Comptez environ 6–7 minutes pour 4 425 lignes. Ne réalisez pas de nouvelles opérations pendant l'import.

**Diagnostic sans clé :** le bouton **Vérifier le connecteur sans clé** appelle uniquement son `/api/status` local, sans lire les champs de clé et sans contacter Kraken. Il distingue une adresse inaccessible, une origine refusée, un serveur lancé sans le mode connecteur, et une synchronisation déjà en cours. Un diagnostic réussi ne valide pas l'authentification Kraken. En cas d'échec d'import privé, les erreurs reconnues distinguent clé invalide, signature/secret incorrect, nonce et code 2FA API ; les erreurs d'authentification ne sont pas présentées à tort comme un problème CORS. Ne partagez jamais une clé dans une conversation ; révoquez toute clé exposée.

### Limites des calculs API

Le ledger API ne contient pas `amountusd`, `feeusd`, `balanceusd` ni forcément le même détail de portefeuille que l'export CSV. Le connecteur **ne remplace jamais ces données manquantes par des cours actuels pour calculer des coûts historiques** :

- Pour un échange simple à deux lignes dont l'une est **USD**, son montant réel USD fournit la référence de coût/produit pour l'autre actif. Les frais crypto de cet échange sont valorisés à son prix d'exécution implicite.
- Les échanges en **EUR** et les conversions crypto/crypto sans référence USD gardent des coûts/produits inconnus. Leurs gains sont marqués partiels. Pour les récompenses, bonus et airdrops **explicitement identifiés**, le coût d'acquisition économique est nul même sans valorisation USD à réception ; seule la valeur historique du revenu et le gain de référence restent inconnus. Le CSV avec valorisations USD reste préférable pour une analyse complète.
- Les quantités finales sont rapprochées avec les soldes API, y compris les suffixes Earn normalisés. Un écart est signalé ; un solde sans historique est importé comme apport inconnu. Les comptes autres que le portefeuille par défaut, Futures et positions externes ne sont pas couverts.
- Après l'import, utilisez **Actualiser les cours** ou des prix manuels pour la valorisation actuelle. Les coûts unitaires estimés restent facultatifs et explicitement signalés.

### Utiliser le connecteur depuis GitHub Pages

Par défaut, utilisez l'interface locale ci-dessus, qui évite les restrictions navigateur d'accès au réseau local. Pour autoriser explicitement votre propre site GitHub Pages, sous Linux/macOS :

```sh
CONNECTOR_ORIGIN=https://VOTRE_COMPTE.github.io npm run connect
```

L'origine ne contient **pas** le chemin du dépôt ni de `/` final. Dans le site GitHub Pages, gardez l'adresse du connecteur `http://127.0.0.1:4173`. Selon le navigateur, il faut autoriser l'accès au réseau local, et certains navigateurs bloquent cette connexion : ouvrez alors l'interface locale. N'utilisez pas de proxy public pour transmettre vos secrets. Le workflow Pages ne déploie pas le serveur ni le module API privé.

Documentation officielle : [authentification](https://docs.kraken.com/api/docs/guides/spot-rest-auth/), [Ledgers et permission requise](https://docs.kraken.com/api/docs/rest-api/get-ledgers-info/), [Balance et permission requise](https://docs.kraken.com/api/docs/rest-api/get-account-balance/).

### Format accepté

Colonnes obligatoires : `txid`, `refid`, `time`, `type`, `asset`, `amount`, `fee`, `balance`, `amountusd`, `feeusd`, `balanceusd`.

Colonnes recommandées : `subtype`, `wallet`, `subclass`, `feecurrency`. Sans `wallet`, toutes les lignes sont considérées comme appartenant à `spot / main` : les exports Earn doivent donc inclure cette colonne. Les dates Kraken sans fuseau sont interprétées en UTC. CSV à virgules ou points-virgules, BOM, champs cités et retours CRLF pris en charge. Taille limitée à 30 Mo. Les lignes identiques avec le même `txid` sont dédupliquées ; les doublons contradictoires sont refusés. Les exports sans colonnes USD sont refusés plutôt que de fabriquer un coût historique. Une valeur USD vide ou `-` est acceptée avec un avertissement : le montant historique reste inconnu, mais un airdrop explicitement identifié a bien un coût d'acquisition économique nul.

## Calculs et limites

La **Décomposition du PnL**, sous le graphique, suit l'actif sélectionné : prix réellement utilisé avec sa source/date, quantité connue/inconnue, valeur connue moins coût restant, comparaison économique/référence à réception et limites Hybrid. Les bougies sont indépendantes de la valorisation du portefeuille : charger le graphique ne rafraîchit pas le prix du tableau. Utilisez **Actualiser les cours** pour comparer un PnL à un cours récent. L'API privée ne permet pas de reconstituer exactement les coûts d'achats en EUR absents de l'historique USD : un résultat partiel n'est pas le PnL complet de l'exchange.

- **Calculs internes en USD**, pour conserver une référence cohérente avec les valorisations historiques Kraken ; affichage USD ou EUR au taux explicite. Les stablecoins sont des actifs suivis ; les monnaies fiat sont exclues des gains crypto.
- **Coût moyen pondéré**, pas FIFO ni calcul fiscal. Les achats augmentent le coût et la quantité ; les ventes retirent une part proportionnelle du coût connu et des unités inconnues.
- Les achats/ventes/conversions sont appariés par `refid`. Le coût d'achat utilise la valeur USD des actifs sortants, augmentée des frais payés **en fiat** sur la sortie ; les frais de réception réduisent les unités acquises. Le produit d'une vente en fiat utilise la valeur USD nette reçue. Pour une conversion crypto/crypto, le produit utilise la valeur USD brute des actifs cédés. Les frais en crypto sortants sont pris en compte par le coût retiré dans le gain réalisé, et ne sont **pas** ajoutés au coût du nouvel actif. Les frais en crypto reçue sont pris en compte par la quantité nette acquise, et ne sont **pas** aussi soustraits du produit de cession. Cela évite un double comptage. Les conversions de plusieurs actifs, notamment `dustsweeping`, répartissent les valeurs proportionnellement aux valorisations USD.
- **Gain non réalisé** = valeur actuelle de la part au coût connu − coût restant de cette part. Les unités inconnues ne sont jamais considérées comme gratuites. Un total incomplet est explicitement marqué **partiel**. Un actif sans prix est exclu de la valeur et du gain totaux.
- **Gain réalisé** = produit attribuable aux unités au coût connu − leur coût retiré, sur les ventes de l'historique. Une vente à coût inconnu laisse ce gain partiel, même si le solde final est nul.
- Les transferts appariés d'un même actif entre portefeuilles Spot/Earn sont neutres, hors frais. Les retraits externes diminuent le stock et son coût mais ne sont pas des ventes. Les dépôts et entrées non appariées ont un coût inconnu.
- **Distributions gratuites : deux conventions**, avec la case **Inclure les récompenses, bonus et airdrops dans les gains** activée par défaut :
  - **Mode économique** : coût d'acquisition nul pour les unités nettes offertes. Leur valeur encore détenue est incluse dans le gain non réalisé ; leur produit net de vente est inclus dans le gain réalisé. Une baisse depuis la réception n'annule pas l'argent reçu gratuitement. Exemple : airdrop valant 100 USD à réception, vendu 50 USD avec 1 USD de frais = **49 USD de gain économique réalisé**, et non une perte de 51 USD.
  - **Mode de référence**, case décochée : la valeur USD nette à réception devient le coût de référence. Le même exemple montre **−51 USD de variation réalisée**, tandis que les 100 USD reçus figurent dans le revenu historique. Ce mode permet de mesurer l'évolution de prix depuis la réception ; ce n'est pas le bénéfice économique global.
  - Les deux livres suivent la même quantité et retirent proportionnellement les coûts payés, les unités offertes et les unités inconnues. Les unités gratuites ne sont pas vendues en priorité ni suivies en FIFO. Une conversion réalise le gain de la crypto cédée et donne à la crypto reçue le coût de l'échange ; le bonus ne suit pas le nouvel actif à coût nul.
  - Les montants **Unités gratuites encore détenues** et **Produit des ventes attribué aux unités gratuites** sont une ventilation informative déjà comprise dans les gains économiques. La carte **Récompenses · valeur à réception** est également informative : **ne l'ajoutez pas une seconde fois** aux gains économiques.
  - Si la valorisation à réception manque, le livre de référence et le revenu historique restent partiels, mais le coût économique de la distribution reste nul. Les frais prélevés sur les unités offertes réduisent la quantité nette, sans être soustraits de nouveau. Un actif offert sans prix actuel reste non valorisé et signalé.
- Identification fondée sur les champs Kraken `type`/`subtype` : `reward`, `airdrop`, `invitebonus`, `welcomebonus`, y compris `earn/reward` et `transfer/airdrop`. Les anciennes écritures positives `staking` sans sous-type sont traitées comme récompenses, sauf transferts appariés équilibrés. Un `transfer` générique, un crédit ou un dépôt ne devient **jamais** un airdrop sur la seule base de son montant. La [documentation Ledgers API](https://docs.kraken.com/api/docs/rest-api/get-ledgers-info/) fournit ces champs mais pas de prix USD historique ; le [guide des types Kraken](https://support.kraken.com/articles/360001169383-how-to-interpret-ledger-history-fields) précise les différences entre transferts, Earn, staking et parrainage.
- Les **soldes initiaux** sont déduits de la première ligne de chaque actif/portefeuille (`balance - amount + fee`), et leur coût reste inconnu. Les ruptures de solde sont signalées et ajustées, sans être interprétées comme des ventes.
- Un solde initial d'un portefeuille vu pour la première fois tard dans l'export est ajouté **à cette première observation**, avec un avertissement. Faute de mouvements antérieurs dans ce portefeuille, il ne modifie pas rétroactivement le coût des ventes précédentes.
- Le **coût estimé** facultatif s'applique par unité à tous les soldes initiaux et apports inconnus d'un actif, au moment de leur entrée, y compris à ceux vendus ensuite. Ce n'est pas une saisie de lots individuels : pour des apports à coûts différents, le résultat demeure une estimation.
- Les prix du CSV sont les **derniers prix implicites disponibles par actif**, avec des dates potentiellement différentes. Ils ne représentent ni un cours actuel ni un instantané à date commune. L'actualisation utilise le dernier échange des paires USD Kraken disponibles ou le prix agrégé USD CoinGecko, selon la source sélectionnée, pas un prix de liquidation garanti. Les actifs indisponibles conservent leurs anciens prix avec un avertissement ; vous pouvez les modifier manuellement. Effacer un prix manuel rétablit le prix de l'export.
- Les **quantités** restent celles à la fin du CSV même après actualisation des prix. Futures, marges, emprunts, opérations hors Kraken et fiscalité ne sont pas couverts. Les frais exprimés dans une autre devise que celle de la ligne sont refusés. Calculs en virgule flottante JavaScript, non adaptés à une comptabilité réglementaire.
- Le total des **frais** est une information, pas une déduction supplémentaire à appliquer aux gains affichés. Les frais de retrait/transfert diminuent le stock ; leur coût n'est pas présenté comme un gain réalisé de vente. Une distribution déjà retirée du compte n'est ni encore détenue ni vendue : sa valeur hors Kraken n'est pas inventée. Le gain non réalisé seul n'est pas le bénéfice depuis l'origine ; les ventes relèvent du réalisé.
- L'export de statistiques inclut le mode sélectionné, les gains des **deux conventions**, les coûts moyens, achats, ventes, frais, quantités reçues gratuitement/restantes et leur ventilation, avec les indicateurs d'incomplétude. La couverture des coûts suit le mode sélectionné et est calculée sur la **valeur disponible** ; les actifs sans prix sont signalés et exclus de son dénominateur. Les distributions documentées sont au coût économique connu (zéro), contrairement aux dépôts d'origine inconnue.

## Développement local

Node.js 22 ou plus récent, sans installation de dépendances :

```sh
npm test
npm start
```

Ouvrez <http://127.0.0.1:4173>. Le serveur local ne sert **que les huit fichiers publics** ; il ne sert pas les exports CSV. Le site utilise des modules JavaScript : passez par HTTP, et non par l'ouverture directe `file://`.

## Publication sur GitHub Pages

1. Créez un dépôt GitHub et poussez le projet sur la branche `main`. Le dossier de départ n'est pas nécessairement déjà un dépôt Git.
2. **N'ajoutez jamais votre export personnel au dépôt**, même privé si vous comptez le rendre public. La règle `.gitignore` exclut les CSV ; elle ne protège pas un fichier déjà suivi ou ajouté avec `git add -f`.
3. Dans **Settings → Pages → Build and deployment**, choisissez **GitHub Actions**.
4. Le workflow [pages.yml](.github/workflows/pages.yml) exécute les tests puis publie **uniquement** `index.html`, `styles.css`, `app.js`, `ledger.js`, `prices.js`, `vault.js`, `market.js` et `chart.js`. Il attend que les métadonnées de l'artefact `github-pages` soient visibles avant le déploiement (12 tentatives maximum). Lancez-le manuellement si nécessaire dans l'onglet Actions.
5. Le site est accessible à `https://VOTRE_COMPTE.github.io/NOM_DU_DEPOT/`. Tous les liens et imports sont relatifs, compatibles avec un sous-chemin de projet.

Il est aussi possible d'héberger ces huit fichiers sur n'importe quel hébergement statique HTTPS. Ne publiez pas tout le dossier en mode « Deploy from a branch » s'il contient des données privées.

Si le déploiement échoue avec **No artifacts named "github-pages"**, vérifiez d'abord que l'étape **Upload Pages artifact** a réussi. Si l'artefact a bien été créé, l'API GitHub peut ne pas encore le voir : le workflow attend maintenant explicitement sa disponibilité. Utilisez **Re-run all jobs** pour recréer un artefact valide ; ne relancez pas uniquement le déploiement avec un artefact expiré ou supprimé. L'avertissement Node `punycode` n'est pas la cause de cette erreur.

## Tests

`npm test` couvre le parsing, les achats, ventes partielles et totales, conversions crypto et poussières, frais, Earn, récompenses, dépôts/retraits, soldes initiaux, coûts inconnus, hypothèses, rapprochements, valorisations et erreurs de l'API de prix. **100 scénarios de conversion avec frais** et **120 historiques de 30 achats/ventes** vérifient la conservation économique : sans apports, retraits externes ni récompenses, gain réalisé + gain non réalisé = valeur finale des cryptos + produits des ventes en fiat − achats payés en fiat. Les tests couvrent aussi les périodes calendaires, OHLC invalides, regroupements de repères, trous et limites d'historique. Les tests utilisent des données fictives et ne dépendent ni du fichier personnel ni du réseau.
