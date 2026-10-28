import { 
  getAvailableDonations, 
  claimDonation, 
  getNgoClaims, 
  updateClaimStatus,
  lookupBarcodeAsync
} from './db.js';
import { showToast } from './toast.js';
import { t, tCat, tUnit, tName, tBizName } from './i18n.js';

let activeImpactChart = null;
let currentNgoId = null;
let currentNgoProfile = null;
let claimCart = []; // client-side basket of pending claims

// Delivery tracking state (NGO side)
const NGO_DELIVERY_PARTNERS = [
  { id: 'swiggy',    name: 'Swiggy Instamart',     emoji: '🟠', color: '#FF5200', rating: 4.8, eta: 18 },
  { id: 'zomato',    name: 'Zomato Hyperpure',      emoji: '🔴', color: '#E23744', rating: 4.7, eta: 22 },
  { id: 'porter',    name: 'Porter',                emoji: '🔵', color: '#3563E9', rating: 4.6, eta: 15 },
  { id: 'dunzo',     name: 'Dunzo Daily',           emoji: '🟢', color: '#00B140', rating: 4.5, eta: 25 },
  { id: 'volunteer', name: 'NutriShare Volunteer',  emoji: '💚', color: '#10b981', rating: 4.9, eta: 35 },
];
const BIZ_COORDS_NGO = [17.3850, 78.4867];
const NGO_COORDS_NGO = [17.4400, 78.3489];

let ngoTrackingMap      = null;
let ngoTrackingInterval = null;
let ngoPartnerMarker    = null;
let ngoActiveDeliveries = {}; // keyed by claim donationId

// Returns a friendly delivery destination label based on recipient type
function getDestLabel(profile) {
  const t = (profile && profile.type) || 'NGO';
  const typeLabels = {
    'Individual / Family': 'home',
    'Old Age Home': 'Old Age Home',
    'Orphanage': 'Orphanage',
    'Student Community': 'Student Hostel',
    'Migrant Workers': 'Community',
    'Disability Center': 'Care Center',
    'Charity Shelter': 'Shelter',
    'Food Bank': 'Food Bank',
    'Community Kitchen': 'Community Kitchen',
  };
  return typeLabels[t] || 'NGO';
}

export function initNgoDashboard(user) {
  currentNgoId = user.id;
  currentNgoProfile = user;
  claimCart = [];

  // Set welcome message
  document.getElementById('ngo-welcome').textContent = `${t('welcome')}, ${user.name}`;
  
  // Dynamic subtitle based on recipient type using i18n keys
  const subtitle = document.querySelector('#view-ngo .hero-info p');
  if (subtitle) {
    const tKeyMap = {
      'Individual / Family': 'ngoSub_family',
      'Old Age Home': 'ngoSub_oldAgeHome',
      'Orphanage': 'ngoSub_orphanage',
      'Student Community': 'ngoSub_studentCommunity',
      'Migrant Workers': 'ngoSub_migrantWorkers',
      'Disability Center': 'ngoSub_disabilityCenter',
      'Charity Shelter': 'ngoSub_charityShelter',
    };
    const key = tKeyMap[user.type] || 'ngoHeroSub';
    subtitle.textContent = t(key);
  }

  // Set up event listeners
  setupSearchAndFilters();
  setupCartCheckout();
  setupSchedulerModal();
  setupNgoDeliveryTracking();
  initNgoScanner(); // Initialize the barcode scanner UI
  
  // Render initial dashboards
  renderDonationFeed();
  renderClaimsCart();
  renderActiveClaimsList();
  renderImpactStats();

  // Tab Navigation inside NGO Dashboard
  const tabBrowse = document.getElementById('ngo-tab-browse');
  const tabClaims = document.getElementById('ngo-tab-claims');
  const tabImpact = document.getElementById('ngo-tab-impact');

  const sectionBrowse = document.getElementById('ngo-sub-browse');
  const sectionClaims = document.getElementById('ngo-sub-claims');
  const sectionImpact = document.getElementById('ngo-sub-impact');

  tabBrowse.addEventListener('click', () => {
    tabBrowse.classList.add('active');
    tabClaims.classList.remove('active');
    tabImpact.classList.remove('active');
    sectionBrowse.classList.remove('d-none');
    sectionClaims.classList.add('d-none');
    sectionImpact.classList.add('d-none');
    renderDonationFeed();
    renderClaimsCart();
  });

  tabClaims.addEventListener('click', () => {
    tabClaims.classList.add('active');
    tabBrowse.classList.remove('active');
    tabImpact.classList.remove('active');
    sectionClaims.classList.remove('d-none');
    sectionBrowse.classList.add('d-none');
    sectionImpact.classList.add('d-none');
    renderActiveClaimsList();
  });

  tabImpact.addEventListener('click', () => {
    tabImpact.classList.add('active');
    tabBrowse.classList.remove('active');
    tabClaims.classList.remove('active');
    sectionImpact.classList.remove('d-none');
    sectionBrowse.classList.add('d-none');
    sectionClaims.classList.add('d-none');
    renderImpactStats();
  });
}

// Initialize the barcode scanner UI and logic
function initNgoScanner() {
  const scannerBtn = document.getElementById('ngo-scanner-btn');
  const modal = document.getElementById('modal-ngo-scan');
  const startBtn = document.getElementById('ngo-scanner-start');
  const stopBtn = document.getElementById('ngo-scanner-stop');
  const closeBtn = document.getElementById('ngo-scanner-close');
  const videoEl = document.getElementById('ngo-scanner-video');
  const cameraSelect = document.getElementById('ngo-camera-select');
  const statusDot = document.getElementById('scanner-status-dot');
  const statusText = document.getElementById('scanner-status-text');
  const resultCard = document.getElementById('ngo-scan-result-card');
  const codeSpan = document.getElementById('scan-result-code');
  const productDiv = document.getElementById('scan-result-product');
  const unknownDiv = document.getElementById('scan-result-unknown');

  const manualInput = document.getElementById('ngo-scan-manual-code');
  const manualBtn = document.getElementById('ngo-scan-manual-btn');
  const fileInput = document.getElementById('ngo-file-input');

  if (!scannerBtn || !modal) return;

  // Safe ZXing reader instance
  let codeReader = null;
  if (window.ZXing && window.ZXing.BrowserMultiFormatReader) {
    try {
      codeReader = new window.ZXing.BrowserMultiFormatReader();
    } catch (e) {
      console.warn('ZXing initialization failed:', e);
    }
  }

  scannerBtn.addEventListener('click', async () => {
    modal.classList.remove('d-none');
    resultCard.classList.add('d-none');
    unknownDiv.classList.add('d-none');
    if (productDiv) productDiv.innerHTML = '';
    
    // Attempt camera listing
    if (codeReader && cameraSelect) {
      try {
        const videoDevices = await codeReader.listVideoInputDevices();
        if (videoDevices && videoDevices.length > 0) {
          cameraSelect.innerHTML = videoDevices.map(d => `<option value="${d.deviceId}">${d.label || 'Camera ' + d.deviceId.slice(0, 5)}</option>`).join('');
        }
      } catch (e) {
        console.log('Camera list notice:', e);
      }
    }
  });

  if (startBtn) {
    startBtn.addEventListener('click', async () => {
      try {
        if (statusDot) statusDot.className = 'scanner-dot active';
        if (statusText) statusText.textContent = 'Scanning camera feed…';
        if (stopBtn) stopBtn.classList.remove('d-none');
        startBtn.classList.add('d-none');
        
        const deviceId = cameraSelect && cameraSelect.value ? cameraSelect.value : null;
        let stream;
        try {
          if (deviceId) {
            stream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: deviceId } } });
          } else {
            stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } } });
          }
        } catch (_) {
          stream = await navigator.mediaDevices.getUserMedia({ video: true });
        }

        videoEl.srcObject = stream;
        videoEl.setAttribute('playsinline', 'true');
        videoEl.muted = true;
        await videoEl.play();

        if (codeReader && typeof codeReader.decodeFromVideoElementContinuously === 'function') {
          codeReader.decodeFromVideoElementContinuously(videoEl, (result, err) => {
            if (result) {
              try { codeReader.reset(); } catch (_) {}
              if (stream) stream.getTracks().forEach(t => t.stop());
              if (stopBtn) stopBtn.classList.add('d-none');
              if (startBtn) startBtn.classList.remove('d-none');
              handleNgoScanResult(result.getText());
            }
          });
        }
      } catch (e) {
        console.error('Failed to start camera scanner:', e);
        if (stopBtn) stopBtn.classList.add('d-none');
        if (startBtn) startBtn.classList.remove('d-none');
        if (statusDot) statusDot.className = 'scanner-dot error';
        if (statusText) statusText.textContent = 'Live camera stream unavailable on this device. Upload photo or use Quick Test below!';
        showToast('Camera Stream Notice', 'Live camera stream unavailable. You can upload a photo of a barcode or use Quick Test below!', 'info');
      }
    });
  }

  // Handle Photo / Image Upload barcode decoding
  if (fileInput) {
    fileInput.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;

      if (statusDot) statusDot.className = 'scanner-dot active';
      if (statusText) statusText.textContent = 'Processing uploaded barcode image…';

      const imgUrl = URL.createObjectURL(file);
      let decodedText = null;

      if ('BarcodeDetector' in window) {
        try {
          const detector = new window.BarcodeDetector({ formats: ['qr_code', 'ean_13', 'ean_8', 'code_128', 'upc_a', 'upc_e'] });
          const imgElement = new Image();
          imgElement.src = imgUrl;
          await imgElement.decode();
          const results = await detector.detect(imgElement);
          if (results && results.length > 0) {
            decodedText = results[0].rawValue;
          }
        } catch (err) {
          console.warn('Native BarcodeDetector notice:', err);
        }
      }

      if (!decodedText && codeReader) {
        try {
          const result = await codeReader.decodeFromImageUrl(imgUrl);
          if (result) decodedText = result.getText();
        } catch (err) {
          console.warn('ZXing image decode notice:', err);
        }
      }

      URL.revokeObjectURL(imgUrl);

      if (decodedText) {
        if (statusDot) statusDot.className = 'scanner-dot idle';
        if (statusText) statusText.textContent = `Barcode detected: ${decodedText}`;
        handleNgoScanResult(decodedText);
      } else {
        if (statusDot) statusDot.className = 'scanner-dot error';
        if (statusText) statusText.textContent = 'Could not detect barcode from image. Try Quick Test below!';
        showToast('Scan Notice', 'Barcode not detected in image. Try typing code or using Quick Test buttons!', 'warning');
      }
      fileInput.value = '';
    });
  }

  if (stopBtn) {
    stopBtn.addEventListener('click', () => {
      if (codeReader) codeReader.reset();
      stopBtn.classList.add('d-none');
      if (startBtn) startBtn.classList.remove('d-none');
      if (statusDot) statusDot.className = 'scanner-dot idle';
      if (statusText) statusText.textContent = 'Scanner stopped.';
    });
  }

  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      if (codeReader) codeReader.reset();
      modal.classList.add('d-none');
    });
  }

  // Manual Scan Input & Quick Test Buttons
  if (manualBtn && manualInput) {
    manualBtn.onclick = () => {
      const val = manualInput.value.trim();
      if (val) {
        handleNgoScanResult(val);
        manualInput.value = '';
      }
    };
    manualInput.onkeypress = (e) => {
      if (e.key === 'Enter') manualBtn.click();
    };
  }

  document.querySelectorAll('.btn-quick-barcode').forEach(btn => {
    btn.onclick = () => {
      const code = btn.dataset.code;
      if (code) handleNgoScanResult(code);
    };
  });

  // Process scan result
  async function handleNgoScanResult(scannedCode) {
    if (resultCard) resultCard.classList.remove('d-none');
    if (codeSpan) codeSpan.textContent = scannedCode;

    const allDonations = getAvailableDonations();
    const match = allDonations.find(d => (d.barcode && d.barcode === scannedCode) || d.name.toLowerCase().includes(scannedCode.toLowerCase()));
    
    if (match) {
      if (unknownDiv) unknownDiv.classList.add('d-none');
      if (productDiv) productDiv.innerHTML = `<strong>🟢 ${match.name}</strong><br>${match.quantity} ${match.unit} from <strong>${match.businessName}</strong>`;
      const alreadyInCart = claimCart.some(item => item.donationId === match.id);
      if (!alreadyInCart) {
        addToCart(match);
        showToast('Item Added via Scan', `"${match.name}" added to your claim basket.`, 'ngo');
      } else {
        showToast('Already in Basket', `"${match.name}" is already in your basket.`, 'warning');
      }
    } else {
      // Fallback search in Open Food Facts API
      if (productDiv) {
        productDiv.innerHTML = `
          <div style="display:flex;align-items:center;gap:0.5rem;padding:0.5rem 0;">
            <div class="scan-spinner" style="width:16px;height:16px;border:2px solid #ccc;border-top-color:#6366f1;border-radius:50%;animation:spin 0.8s linear infinite;"></div>
            <span style="font-size:0.8rem;color:var(--text-secondary);">Querying Open Food Facts API...</span>
          </div>`;
      }
      
      const apiProduct = await lookupBarcodeAsync(scannedCode);
      if (apiProduct) {
        if (unknownDiv) unknownDiv.classList.add('d-none');
        if (productDiv) {
          productDiv.innerHTML = `
            <strong>${apiProduct.name}</strong> (Open Food Facts 🌐)<br>
            <span style="font-size:0.8rem;color:var(--text-muted);">This item is in the global database but has not been listed by any local business donors yet.</span>
          `;
        }
        showToast('Product Identified', `"${apiProduct.name}" found in global database.`, 'info');
      } else {
        if (productDiv) productDiv.innerHTML = '';
        if (unknownDiv) unknownDiv.classList.remove('d-none');
        showToast('Barcode Not Found', `No active listing or global record found for "${scannedCode}".`, 'warning');
      }
    }
  }
}

// --- 1. Search & Filter Listings Feed ---
function setupSearchAndFilters() {
  const searchInput = document.getElementById('ngo-search');
  const filterCat = document.getElementById('ngo-filter-cat');

  searchInput.addEventListener('input', renderDonationFeed);
  filterCat.addEventListener('change', renderDonationFeed);
}

function renderDonationFeed() {
  const container = document.getElementById('ngo-donation-cards');
  container.innerHTML = '';

  const query = document.getElementById('ngo-search').value.toLowerCase().trim();
  const category = document.getElementById('ngo-filter-cat').value;
  
  const allDonations = getAvailableDonations();
  
  // Filter
  const filtered = allDonations.filter(don => {
    const matchesQuery = don.name.toLowerCase().includes(query) || don.businessName.toLowerCase().includes(query);
    const matchesCategory = category === 'All' || don.category === category;
    
    // Don't show in feed if it is already in our claims cart
    const inCart = claimCart.some(cartItem => cartItem.donationId === don.id);
    
    return matchesQuery && matchesCategory && !inCart;
  });

  // Update available listing stat counts
  document.getElementById('ngo-stat-listings').textContent = allDonations.length;

  if (filtered.length === 0) {
    container.innerHTML = `
      <div style="grid-column: 1 / -1; text-align: center; padding: 3rem; color: var(--text-secondary); width: 100%;">
        <i data-lucide="package-search" style="font-size: 2.5rem; margin-bottom: 0.5rem; color: var(--text-muted);"></i>
        <p>No available food donations matching your filters. Try checking back shortly!</p>
      </div>`;
    lucide.createIcons();
    return;
  }

  filtered.forEach(don => {
    const card = document.createElement('div');
    card.className = 'card-glass donation-card card-ngo-glow';
    
    // Status color badge based on days left
    const expDate = new Date(don.expiryDate);
    const today = new Date();
    const daysLeft = Math.ceil((expDate - today) / (1000 * 60 * 60 * 24));
    
    let expBadgeClass = 'badge-safe';
    let expText = `${daysLeft} ${t('daysLeft')}`;
    if (daysLeft <= 0) {
      expBadgeClass = 'badge-critical';
      expText = t('expired');
    } else if (daysLeft <= 2) {
      expBadgeClass = 'badge-critical';
      expText = `${t('critical')}: ${daysLeft}d`;
    } else if (daysLeft <= 5) {
      expBadgeClass = 'badge-warning';
      expText = `${t('warning')}: ${daysLeft}d`;
    }

    const isCookedFood = don.category === 'Cooked Food';
    const cookedBadge = isCookedFood 
      ? `<div style="margin-top:0.4rem; font-size:0.7rem; background:rgba(245,158,11,0.15); color:#fbbf24; border:1px solid rgba(245,158,11,0.3); padding:0.2rem 0.5rem; border-radius:6px; font-weight:600; display:inline-flex; align-items:center; gap:0.3rem;">
           <span>🍲 Cooked Food Handling Certified (Safe &lt;4h window)</span>
         </div>`
      : '';

    card.innerHTML = `
      <div>
        <div class="don-card-header">
          <div>
            <span class="don-card-cat">${tCat(don.category)}</span>
            <h4 class="don-card-title">${tName(don.name)}</h4>
            ${cookedBadge}
          </div>
          <span class="badge-status ${expBadgeClass}">${expText}</span>
        </div>

        <div class="don-details-list">
          <div class="don-detail-item">
            <i data-lucide="package"></i>
            <span>${t('quantity')}: <strong>${don.quantity} ${tUnit(don.unit)}</strong></span>
          </div>
          <div class="don-detail-item">
            <i data-lucide="building"></i>
            <span>${t('from')}: <strong>${tBizName(don.businessName)}</strong></span>
          </div>
          <div class="don-detail-item">
            <i data-lucide="navigation"></i>
            <span>${t('location')}: <strong>${don.businessAddress} (${don.distance})</strong></span>
          </div>
        </div>
      </div>

      <div class="don-card-action">
        <button class="btn btn-primary-ngo btn-add-cart" data-id="${don.id}">
          <i data-lucide="plus"></i> ${t('addToClaimBasket')}
        </button>
      </div>
    `;
    container.appendChild(card);
  });

  // Re-hook Icons safely
  try {
    lucide.createIcons();
  } catch(e) {}

  // Attach button event listeners via event delegation
  container.onclick = (e) => {
    const btn = e.target.closest('.btn-add-cart');
    if (btn) {
      const donId = btn.dataset.id;
      const don = allDonations.find(d => d.id === donId);
      if (don) {
        addToCart(don);
      }
    }
  };
}

// --- 2. Claims Cart/Basket Management ---
function addToCart(donation) {
  claimCart.push({
    donationId: donation.id,
    name: donation.name,
    category: donation.category,
    quantity: donation.quantity,
    unit: donation.unit,
    businessName: donation.businessName,
    businessAddress: donation.businessAddress,
    expiryDate: donation.expiryDate
  });

  renderClaimsCart();
  renderDonationFeed(); // refresh feed to hide this item
}

function removeFromCart(donationId) {
  claimCart = claimCart.filter(item => item.donationId !== donationId);
  renderClaimsCart();
  renderDonationFeed(); // return to feed
}

function renderClaimsCart() {
  const cartContainer = document.getElementById('ngo-cart-items');
  const checkoutBtn = document.getElementById('btn-checkout-claims');
  
  // Update stats
  document.getElementById('ngo-stat-cart-count').textContent = claimCart.length;
  document.getElementById('cart-counter-badge').textContent = claimCart.length;

  cartContainer.innerHTML = '';

  if (claimCart.length === 0) {
    cartContainer.innerHTML = `
      <p class="text-muted text-center" style="font-size: 0.85rem; padding: 2rem 0;">${t('emptyBasket')}</p>
    `;
    checkoutBtn.disabled = true;
    return;
  }

  checkoutBtn.disabled = false;

  claimCart.forEach(item => {
    const div = document.createElement('div');
    div.className = 'cart-item';
    div.innerHTML = `
      <div class="cart-item-info">
        <h5>${tName(item.name)}</h5>
        <p>${item.quantity} ${tUnit(item.unit)} • ${item.businessName}</p>
      </div>
      <button class="cart-remove-btn" data-id="${item.donationId}">
        <i data-lucide="trash-2"></i>
      </button>
    `;
    cartContainer.appendChild(div);
  });

  // Re-hook Icons
  lucide.createIcons();

  // Attach remove triggers
  cartContainer.querySelectorAll('.cart-remove-btn').forEach(btn => {
    btn.onclick = () => {
      removeFromCart(btn.dataset.id);
    };
  });
}

function setupCartCheckout() {
  const btn = document.getElementById('btn-checkout-claims');
  const modal = document.getElementById('modal-schedule-claim');
  const closeBtn = document.getElementById('btn-close-claim-modal');

  btn.onclick = () => {
    modal.classList.remove('d-none');
    
    // Set default pickup datetime to 2 hours from now
    const now = new Date();
    now.setHours(now.getHours() + 2);
    // Format YYYY-MM-DDThh:mm
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    document.getElementById('claim-pickup-time').value = `${year}-${month}-${day}T${hours}:${minutes}`;
  };

  closeBtn.onclick = () => {
    modal.classList.add('d-none');
  };
}

// --- 3. Claims Scheduler Form ---
function setupSchedulerModal() {
  const form = document.getElementById('form-schedule-claim');
  const modal = document.getElementById('modal-schedule-claim');

  form.onsubmit = (e) => {
    e.preventDefault();
    const pickupTime = document.getElementById('claim-pickup-time').value;
    const transportType = document.getElementById('claim-transport').value;
    const contact = document.getElementById('claim-contact').value.trim();

    try {
      // Loop claims basket and write database entries
      const claimedItems = [...claimCart];
      claimCart.forEach(item => {
        claimDonation(
          currentNgoId,
          currentNgoProfile.name,
          item.donationId,
          item.quantity,
          pickupTime,
          contact,
          transportType
        );
      });

      // AUTO-ASSIGN a delivery partner for each claimed item
      const destLabel = getDestLabel(currentNgoProfile);
      claimedItems.forEach((item, idx) => {
        const partner = NGO_DELIVERY_PARTNERS[Math.floor(Math.random() * NGO_DELIVERY_PARTNERS.length)];
        ngoActiveDeliveries[item.donationId] = {
          partner,
          donationName: item.name,
          status: 'assigned',
          assignedAt: Date.now()
        };

        // Show "NutriShare Partner Assigned" notification
        setTimeout(() => {
          showToast(
            `🎉 NutriShare Partner Assigned!`,
            `${partner.name} (⭐${partner.rating}) has been assigned to deliver "${item.name}" from ${item.businessName} to your ${destLabel}. ETA ~${partner.eta} min.`,
            'ngo'
          );
        }, 600 + (idx * 800));
      });

      // Clear basket, alert, navigate to active pickups
      claimCart = [];
      modal.classList.add('d-none');
      showToast('✅ NutriShare Partner Assigned', `Delivery partners have been assigned for all your claims! Your items will be delivered directly to your ${destLabel}. Track below.`, 'ngo');
      
      // Select the Active Pickups tab programmatically
      document.getElementById('ngo-tab-claims').click();
    } catch (err) {
      showToast('Scheduling Failed', err.message, 'error');
    }
  };
}

// --- 4. Render Active Pickup Lists & Timelines ---
function renderActiveClaimsList() {
  const container = document.getElementById('ngo-active-claims-list');
  container.innerHTML = '';

  const claims = getNgoClaims(currentNgoId);

  if (claims.length === 0) {
    container.innerHTML = `
      <div style="grid-column: 1 / -1; text-align: center; padding: 4rem; color: var(--text-secondary); width: 100%;">
        <i data-lucide="truck" style="font-size: 3rem; margin-bottom: 0.5rem; color: var(--text-muted);"></i>
        <p>No active scheduled claims. Browse available food listings to create a delivery route ticket.</p>
      </div>`;
    lucide.createIcons();
    return;
  }

  claims.forEach(c => {
    const card = document.createElement('div');
    card.className = 'card-glass claim-card';
    
    // Status Flow indices
    const stepScheduled = c.status === 'scheduled' || c.status === 'picked_up' || c.status === 'distributed';
    const stepPickedUp = c.status === 'picked_up' || c.status === 'distributed';
    const stepDistributed = c.status === 'distributed';

    card.innerHTML = `
      <div>
        <div class="don-card-header">
          <div>
            <span class="don-card-cat">${tCat(c.category)}</span>
            <h4 class="don-card-title">${tName(c.name)}</h4>
          </div>
          <span class="badge-status ${c.status === 'distributed' ? 'badge-safe' : 'badge-warning'}">${c.status === 'distributed' ? t('distributed') : c.status === 'picked_up' ? t('statusPickedUp') : t('scheduled')}</span>
        </div>

        <div style="font-size: 0.85rem; color: var(--text-secondary); margin-bottom: 0.5rem;">
          <p>${t('pickupSpot')}: <strong>${tBizName(c.businessName) || 'N/A'}</strong></p>
          <p>${t('quantityClaimed')}: <strong>${c.quantity} ${tUnit(c.unit)}</strong></p>
          <p>${t('assignedDriver')}: <strong style="color:var(--accent-ngo);">🚴 ${c.assignedDriverName || 'Ramesh Kumar'}</strong> (📞 ${c.assignedDriverContact || '555-9011'})</p>
          <p>${t('vehicle')}: <strong>${c.assignedDriverVehicle || c.transportType || 'Motorbike'}</strong></p>
        </div>

        <!-- Custom Step Timeline -->
        <div class="claim-status-timeline">
          <div class="timeline-step ${stepScheduled ? (c.status === 'scheduled' ? 'active' : 'completed') : ''}">
            <div class="timeline-node"><i data-lucide="calendar"></i></div>
            <span>${t('scheduled')}</span>
          </div>
          <div class="timeline-step ${c.status === 'picked_up' ? 'active' : (stepPickedUp ? 'completed' : '')}">
            <div class="timeline-node"><i data-lucide="truck"></i></div>
            <span>${t('statusPickedUp')}</span>
          </div>
          <div class="timeline-step ${c.status === 'distributed' ? 'active' : ''}">
            <div class="timeline-node"><i data-lucide="home"></i></div>
            <span>${t('distributed')}</span>
          </div>
        </div>
      </div>

      <div class="don-card-action mt-3">
        <button class="btn btn-secondary btn-ticket-trigger" 
          data-name="${c.name}" 
          data-category="${c.category}" 
          data-provider="${c.businessName || ''}"
          data-provider-addr="${c.businessAddress || ''}" 
          data-qty="${c.quantity} ${c.unit}" 
          data-time="${(c.pickupTime || '').replace('T', ' ')}" 
          data-vehicle="${c.transportType || ''}">
          <i data-lucide="ticket"></i> ${t('viewTicket')}
        </button>

        ${ngoActiveDeliveries[c.donationId]
          ? `<button class="btn btn-primary-ngo" onclick="ngoOpenTracking('${c.donationId}','${c.name}')">
               📍 ${t('trackDelivery')}
             </button>`
          : ''
        }
        
        ${c.status === 'scheduled' 
          ? `<button class="btn btn-primary-ngo btn-status-advance" data-donid="${c.donationId}" data-next="picked_up">
              <i data-lucide="check"></i> ${t('confirmPickedUp')}
             </button>`
          : c.status === 'picked_up'
          ? `<button class="btn btn-primary-ngo btn-status-advance" data-donid="${c.donationId}" data-next="distributed" style="background:var(--grad-business);">
              <i data-lucide="smile"></i> ${t('confirmDistributed')}
             </button>`
          : `<span class="text-success text-center w-full" style="font-weight: 700; font-size: 0.85rem; padding: 0.5rem 0;">
              <i data-lucide="shield-check"></i> ${t('rescueCompleted')}
             </span>`
        }
      </div>
    `;
    container.appendChild(card);
  });

  // Re-hook Icons safely
  try {
    lucide.createIcons();
  } catch(e) {}

  // Attach button triggers via event delegation
  container.onclick = (e) => {
    const ticketBtn = e.target.closest('.btn-ticket-trigger');
    if (ticketBtn) {
      openTicketModal(ticketBtn.dataset);
      return;
    }

    const statusBtn = e.target.closest('.btn-status-advance');
    if (statusBtn) {
      updateClaimStatus(statusBtn.dataset.donid, statusBtn.dataset.next);
      renderActiveClaimsList();
      return;
    }
  };
}

// --- 5. NGO Impact Tracker Statistics ---
function renderImpactStats() {
  const claims = getNgoClaims(currentNgoId);
  const completedClaims = claims.filter(c => c.status === 'distributed');
  const activeClaims = claims.filter(c => c.status !== 'distributed');

  // 1 item default weights (kg): Produce: 1.0, Bakery: 0.5, Dairy: 1.0, Meat: 1.0, Cooked Food: 0.8.
  let totalRescuedKg = 0;

  // Track category counts
  const categoryVolumes = {
    Produce: 0,
    Bakery: 0,
    Dairy: 0,
    Meat: 0,
    'Cooked Food': 0,
    Other: 0
  };

  claims.forEach(c => {
    // Quantify units to KG for stats
    let kgMultiplier = 1;
    if (c.unit.toLowerCase() === 'units') {
      if (c.category === 'Produce') kgMultiplier = 0.2; // average fruit
      else if (c.category === 'Bakery') kgMultiplier = 0.5; // loaf
      else if (c.category === 'Dairy') kgMultiplier = 1.0; // milk bottle/yogurt tub
      else if (c.category === 'Meat') kgMultiplier = 0.5;
      else kgMultiplier = 0.4;
    }
    
    const itemWeight = c.quantity * kgMultiplier;
    
    // Only count completed claims for impact stats, but count all for aggregate categories
    if (c.status === 'distributed') {
      totalRescuedKg += itemWeight;
    }
    
    const catKey = categoryVolumes[c.category] !== undefined ? c.category : 'Other';
    categoryVolumes[catKey] += itemWeight;
  });

  // Calculate environmental equivalents
  const co2Saved = totalRescuedKg * 2.5; // 2.5 kg CO2 per kg food saved
  const waterSaved = totalRescuedKg * 1200; // 1200 L per kg
  const mealsServed = totalRescuedKg / 0.4; // 0.4 kg per average meal

  // Update DOM metrics
  document.getElementById('ngo-stat-rescued').textContent = `${totalRescuedKg.toFixed(1)} kg`;
  document.getElementById('ngo-stat-co2').textContent = `${co2Saved.toFixed(0)} kg`;
  
  // Dashboard tab stats
  document.getElementById('impact-stat-active').textContent = activeClaims.length;
  document.getElementById('impact-stat-completed').textContent = completedClaims.length;
  document.getElementById('impact-stat-co2').textContent = `${co2Saved.toFixed(1)} kg`;
  
  // Ecological cards
  document.getElementById('impact-water-saved').textContent = `${Math.round(waterSaved).toLocaleString()} Liters`;
  document.getElementById('impact-meals-served').textContent = `${Math.round(mealsServed).toLocaleString()} Meals`;

  // Draw Pie chart
  drawImpactPieChart(categoryVolumes);
}

function drawImpactPieChart(categoryVolumes) {
  const ctx = document.getElementById('ngo-impact-pie-chart').getContext('2d');
  
  if (activeImpactChart) {
    activeImpactChart.destroy();
  }

  const categories = Object.keys(categoryVolumes);
  const dataValues = Object.values(categoryVolumes);

  // If no items rescued, use a dummy graph
  const hasData = dataValues.some(val => val > 0);
  const chartData = hasData ? dataValues : [20, 10, 15, 5, 25, 5];
  const chartLabels = hasData ? categories : ['Produce (mock)', 'Bakery (mock)', 'Dairy (mock)', 'Meat (mock)', 'Cooked Food (mock)', 'Other (mock)'];

  activeImpactChart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: chartLabels,
      datasets: [{
        data: chartData,
        backgroundColor: [
          '#10b981', // Produce - emerald
          '#f59e0b', // Bakery - orange/amber
          '#3b82f6', // Dairy - blue
          '#ef4444', // Meat - red/coral
          '#a855f7', // Cooked Food - purple
          '#64748b'  // Other - slate
        ],
        borderWidth: 1,
        borderColor: 'rgba(15, 23, 42, 0.7)'
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: 'right',
          labels: {
            color: '#94a3b8',
            font: { family: 'Outfit', size: 10 }
          }
        },
        tooltip: {
          backgroundColor: '#0b1120',
          titleColor: '#f8fafc',
          bodyColor: '#e2e8f0',
          borderColor: '#475569',
          borderWidth: 1
        }
      },
      cutout: '70%'
    }
  });
}

// --- 6. Routing Ticket Modal ---
function openTicketModal(data) {
  const modal = document.getElementById('modal-ticket');
  modal.classList.remove('d-none');

  document.getElementById('ticket-item-name').textContent = data.name;
  document.getElementById('ticket-category').textContent = data.category;
  document.getElementById('ticket-provider').textContent = data.provider;
  document.getElementById('ticket-provider-addr').textContent = data.providerAddr;
  document.getElementById('ticket-qty').textContent = data.qty;
  document.getElementById('ticket-time').textContent = data.time;
  document.getElementById('ticket-vehicle').textContent = data.vehicle;

  // Set maps icons
  let mapIconClass = 'truck';
  if (data.vehicle.includes('Bike')) mapIconClass = 'bike';
  else if (data.vehicle.includes('Foot')) mapIconClass = 'footprints';
  
  const mapCourier = document.querySelector('.map-courier');
  mapCourier.className = `map-courier`;
  mapCourier.setAttribute('data-lucide', mapIconClass);
  
  lucide.createIcons();

  const closeBtn = document.getElementById('btn-close-ticket-modal');
  const doneBtn = document.getElementById('btn-ticket-done');

  const hideModal = () => modal.classList.add('d-none');
  closeBtn.onclick = hideModal;
  doneBtn.onclick = hideModal;
}

// ═══════════════════════════════════════════════════════
// NGO DELIVERY TRACKING SYSTEM
// ═══════════════════════════════════════════════════════

function setupNgoDeliveryTracking() {
  document.getElementById('btn-close-tracking-modal').onclick = () => {
    document.getElementById('modal-tracking').classList.add('d-none');
    if (ngoTrackingInterval) { clearInterval(ngoTrackingInterval); ngoTrackingInterval = null; }
    if (ngoTrackingMap) { ngoTrackingMap.remove(); ngoTrackingMap = null; }
  };
}

function ngoOpenTracking(donationId, donationName) {
  const delivery = ngoActiveDeliveries[donationId];
  if (!delivery) return;
  const partner = delivery.partner;
  const destLabel = getDestLabel(currentNgoProfile);

  const modal = document.getElementById('modal-tracking');
  modal.classList.remove('d-none');

  document.getElementById('tracking-partner-name').textContent = `${donationName} · ${partner.name} coming to you`;
  document.getElementById('tracking-partner-avatar').textContent = partner.emoji;
  document.getElementById('tracking-partner-info-name').textContent = partner.name;
  document.getElementById('tracking-partner-info-sub').textContent = `Delivering to your ${destLabel} · ETA ~${partner.eta} min`;
  document.getElementById('tracking-partner-rating').textContent = `⭐ ${partner.rating}`;

  // Reset steps
  ['assigned','pickup','transit','delivered'].forEach(s => {
    const el = document.getElementById(`tstep-${s}`);
    if (el) el.classList.remove('tstep-active','tstep-done');
  });
  const stepAssigned = document.getElementById('tstep-assigned');
  if (stepAssigned) stepAssigned.classList.add('tstep-done');

  setTimeout(() => {
    if (ngoTrackingMap)     { ngoTrackingMap.remove(); ngoTrackingMap = null; }
    if (ngoTrackingInterval){ clearInterval(ngoTrackingInterval); }

    // Map centered between biz and NGO
    ngoTrackingMap = L.map('tracking-map', { zoomControl: true }).setView(
      [(BIZ_COORDS_NGO[0] + NGO_COORDS_NGO[0]) / 2, (BIZ_COORDS_NGO[1] + NGO_COORDS_NGO[1]) / 2], 13
    );
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap contributors'
    }).addTo(ngoTrackingMap);

    // Business marker (pickup point)
    const bizIcon = L.divIcon({
      html: `<div style="background:${partner.color};color:#fff;border-radius:50%;width:36px;height:36px;display:flex;align-items:center;justify-content:center;font-size:1.1rem;border:3px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,0.4);">🏪</div>`,
      className: '', iconSize: [36,36], iconAnchor: [18,18]
    });
    L.marker(BIZ_COORDS_NGO, { icon: bizIcon }).addTo(ngoTrackingMap).bindPopup('<b>Food Pickup Point</b><br>Business store').openPopup();

    // NGO marker (YOU are here)
    const ngoIcon = L.divIcon({
      html: `<div style="background:#6366f1;color:#fff;border-radius:50%;width:40px;height:40px;display:flex;align-items:center;justify-content:center;font-size:1.2rem;border:3px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,0.4);">📍</div>`,
      className: '', iconSize: [40,40], iconAnchor: [20,20]
    });
    L.marker(NGO_COORDS_NGO, { icon: ngoIcon }).addTo(ngoTrackingMap).bindPopup(`<b>${currentNgoProfile.name} (Destination)</b><br>Delivery coming here!`);

    // Route line
    L.polyline([BIZ_COORDS_NGO, NGO_COORDS_NGO], { color: partner.color, weight: 4, dashArray: '8 6', opacity: 0.75 }).addTo(ngoTrackingMap);

    // Delivery partner marker – starts at biz, moves towards NGO
    const dpIcon = L.divIcon({
      html: `<div style="background:${partner.color};color:#fff;border-radius:50%;width:44px;height:44px;display:flex;align-items:center;justify-content:center;font-size:1.5rem;border:3px solid #fff;box-shadow:0 3px 14px rgba(0,0,0,0.55);">${partner.emoji}</div>`,
      className: '', iconSize: [44,44], iconAnchor: [22,22]
    });
    ngoPartnerMarker = L.marker(BIZ_COORDS_NGO, { icon: dpIcon }).addTo(ngoTrackingMap);
    ngoPartnerMarker.bindPopup(`<b>${partner.name}</b><br>On the way to your ${destLabel}!`).openPopup();

    let step = 0;
    const totalSteps = 60;
    const etaMin = partner.eta;

    ngoTrackingInterval = setInterval(() => {
      step++;
      const progress = Math.min(step / totalSteps, 1);
      const lat = BIZ_COORDS_NGO[0] + (NGO_COORDS_NGO[0] - BIZ_COORDS_NGO[0]) * progress;
      const lng = BIZ_COORDS_NGO[1] + (NGO_COORDS_NGO[1] - BIZ_COORDS_NGO[1]) * progress;
      const remainingKm  = +(((1 - progress) * 8.2).toFixed(1));
      const remainingMin = Math.max(0, Math.round(etaMin * (1 - progress)));

      ngoPartnerMarker.setLatLng([lat, lng]);
      document.getElementById('tracking-distance').textContent = `${remainingKm} km`;
      document.getElementById('tracking-eta-text').textContent = remainingMin > 0 ? `ETA: ${remainingMin} min` : '🎉 Arriving now!';

      if (progress >= 0.05) {
        document.getElementById('tstep-assigned').classList.add('tstep-done');
      }
      if (progress >= 0.25) {
        document.getElementById('tstep-pickup').classList.add('tstep-done');
        document.getElementById('tracking-status-text').textContent = `${partner.name} picked up the food from the store`;
      }
      if (progress >= 0.6) {
        document.getElementById('tstep-transit').classList.add('tstep-done');
        document.getElementById('tracking-status-text').textContent = `${partner.name} is on the way to your ${destLabel}`;
      }
      if (progress >= 1) {
        document.getElementById('tstep-delivered').classList.add('tstep-done');
        document.getElementById('tracking-status-text').textContent = `✅ Food delivered to your ${destLabel}!`;
        document.getElementById('tracking-eta-bar').style.background = 'rgba(16,185,129,0.15)';
        clearInterval(ngoTrackingInterval);
        ngoTrackingInterval = null;
        delivery.status = 'delivered';
        showToast('🎉 Food Delivered!', `${partner.name} has delivered "${donationName}" to your ${destLabel}!`, 'ngo');
      }
    }, 3000);

  }, 200);
}

// Expose for inline onclick
window.ngoOpenTracking = ngoOpenTracking;
