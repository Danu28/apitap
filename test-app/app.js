/**
 * FlowTrace QA Test Application
 * Simulates real-world interactions for testing the extension
 */

// API Base URL (using JSONPlaceholder for testing)
const API_BASE = 'https://jsonplaceholder.typicode.com';

// DOM Elements
const elements = {
  btnFetchUser: document.getElementById('btnFetchUser'),
  userResult: document.getElementById('userResult'),
  loginForm: document.getElementById('loginForm'),
  loginResult: document.getElementById('loginResult'),
  searchInput: document.getElementById('searchInput'),
  btnSearch: document.getElementById('btnSearch'),
  searchResults: document.getElementById('searchResults'),
  btnLoadPosts: document.getElementById('btnLoadPosts'),
  postsContainer: document.getElementById('postsContainer'),
  btnCreateItem: document.getElementById('btnCreateItem'),
  itemList: document.getElementById('itemList')
};

// State
let items = [];

/**
 * Initialize event listeners
 */
function init() {
  elements.btnFetchUser.addEventListener('click', fetchUser);
  elements.loginForm.addEventListener('submit', handleLogin);
  elements.btnSearch.addEventListener('click', searchPosts);
  elements.searchInput.addEventListener('input', debounce(searchPosts, 500));
  elements.btnLoadPosts.addEventListener('click', loadPosts);
  elements.btnCreateItem.addEventListener('click', createItem);
}

/**
 * Test 1: Fetch User Data (GET request)
 */
async function fetchUser() {
  showLoading(elements.userResult);

  try {
    const response = await fetch(`${API_BASE}/users/1`);
    const user = await response.json();

    elements.userResult.innerHTML = `
      <strong>✅ User Fetched Successfully!</strong>
      <pre>${JSON.stringify(user, null, 2)}</pre>
    `;
    elements.userResult.classList.add('show');

    // Trigger DOM mutation event for extension to capture
    triggerDOMMutation('user-loaded');

  } catch (error) {
    elements.userResult.innerHTML = `<strong>❌ Error:</strong> ${error.message}`;
    elements.userResult.classList.add('show');
  }
}

/**
 * Test 2: Handle Login Form (POST request)
 */
async function handleLogin(e) {
  e.preventDefault();

  const username = document.getElementById('username').value;
  const password = document.getElementById('password').value;

  showLoading(elements.loginResult);

  try {
    const response = await fetch(`${API_BASE}/posts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        title: `Login attempt by ${username}`,
        body: 'Authentication test',
        userId: 1
      })
    });

    const data = await response.json();

    elements.loginResult.innerHTML = `
      <strong>✅ Login Successful!</strong>
      <p>Welcome, ${username}!</p>
      <pre>${JSON.stringify(data, null, 2)}</pre>
    `;
    elements.loginResult.classList.add('show');

    // Clear form
    document.getElementById('username').value = '';
    document.getElementById('password').value = '';

    triggerDOMMutation('login-success');

  } catch (error) {
    elements.loginResult.innerHTML = `<strong>❌ Login Failed:</strong> ${error.message}`;
    elements.loginResult.classList.add('show');
  }
}

/**
 * Test 3: Search Posts (GET with query)
 */
async function searchPosts() {
  const query = elements.searchInput.value.trim();

  if (!query) {
    elements.searchResults.innerHTML = '<p>Please enter a search term</p>';
    elements.searchResults.classList.add('show');
    return;
  }

  showLoading(elements.searchResults);

  try {
    const response = await fetch(`${API_BASE}/posts?q=${encodeURIComponent(query)}`);
    const posts = await response.json();

    if (posts.length === 0) {
      elements.searchResults.innerHTML = '<p>No results found</p>';
    } else {
      elements.searchResults.innerHTML = `
        <strong>✅ Found ${posts.length} results</strong>
        <pre>${JSON.stringify(posts.slice(0, 3), null, 2)}</pre>
        <p><em>Showing first 3 results...</em></p>
      `;
    }

    elements.searchResults.classList.add('show');
    triggerDOMMutation('search-results');

  } catch (error) {
    elements.searchResults.innerHTML = `<strong>❌ Search Failed:</strong> ${error.message}`;
    elements.searchResults.classList.add('show');
  }
}

/**
 * Test 4: Load Posts (Grid of clickable items)
 */
async function loadPosts() {
  showLoading(elements.postsContainer);

  try {
    const response = await fetch(`${API_BASE}/posts?_limit=6`);
    const posts = await response.json();

    elements.postsContainer.innerHTML = posts.map(post => `
      <div class="post-card" data-id="${post.id}" onclick="selectPost(${post.id})">
        <h4>${post.title.substring(0, 30)}...</h4>
        <p>${post.body.substring(0, 80)}...</p>
      </div>
    `).join('');

    triggerDOMMutation('posts-loaded');

  } catch (error) {
    elements.postsContainer.innerHTML = `<p>❌ Failed to load posts: ${error.message}</p>`;
  }
}

/**
 * Select a post (click handler)
 */
function selectPost(id) {
  console.log('Selected post:', id);

  // Fetch post details
  fetch(`${API_BASE}/posts/${id}`)
    .then(res => res.json())
    .then(post => {
      alert(`Selected Post #${id}\n\nTitle: ${post.title}\n\nBody: ${post.body.substring(0, 100)}...`);
      triggerDOMMutation('post-selected');
    });
}

/**
 * Test 5: Create Item (simulated)
 */
function createItem() {
  const itemId = items.length + 1;
  const item = {
    id: itemId,
    name: `Item ${itemId}`,
    createdAt: new Date().toISOString()
  };

  items.push(item);
  renderItem(item);

  // Simulate API call
  simulateAPICall('POST', '/items', item);

  triggerDOMMutation('item-created');
}

/**
 * Render item to list
 */
function renderItem(item) {
  const li = document.createElement('li');
  li.innerHTML = `
    <span>${item.name} - Created: ${new Date(item.createdAt).toLocaleTimeString()}</span>
    <button onclick="deleteItem(${item.id})">Delete</button>
  `;
  elements.itemList.appendChild(li);
}

/**
 * Delete item (simulated DELETE request)
 */
function deleteItem(id) {
  const item = items.find(i => i.id === id);
  if (!item) return;

  // Simulate API call
  simulateAPICall('DELETE', `/items/${id}`, { id });

  // Remove from list
  const li = elements.itemList.querySelector(`button[onclick="deleteItem(${id})"]`).parentElement;
  li.remove();

  items = items.filter(i => i.id !== id);
  triggerDOMMutation('item-deleted');
}

/**
 * Simulate API call for extension to capture
 */
async function simulateAPICall(method, url, data) {
  console.log(`Simulated ${method} ${url}:`, data);

  // Create a real fetch call that the extension can capture
  try {
    await fetch(`${API_BASE}/posts`, {
      method: method === 'DELETE' ? 'DELETE' : 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: method === 'DELETE' ? null : JSON.stringify(data)
    });
  } catch (error) {
    console.log('Simulated API call completed');
  }
}

/**
 * Trigger DOM mutation event
 */
function triggerDOMMutation(eventName) {
  const event = new CustomEvent('flowtrace:mutation', {
    detail: { eventName, timestamp: Date.now() }
  });
  document.dispatchEvent(event);
}

/**
 * Show loading state
 */
function showLoading(element) {
  element.innerHTML = '<span class="loading"></span> Loading...';
  element.classList.add('show');
}

/**
 * Debounce function
 */
function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

// Make selectPost and deleteItem global for inline onclick handlers
window.selectPost = selectPost;
window.deleteItem = deleteItem;

// Initialize on DOM ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

console.log('🧪 FlowTrace QA Test App initialized');
console.log('👉 Open Chrome DevTools → FlowTrace QA tab → Start Recording');
