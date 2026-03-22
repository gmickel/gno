// GNO Documentation Site - Main JavaScript

(function () {
  "use strict";

  // ==========================================================================
  // Theme Toggle
  // ==========================================================================

  const themeToggle = document.getElementById("theme-toggle");

  function getPreferredTheme() {
    const stored = localStorage.getItem("gno-theme");
    if (stored) return stored;
    return window.matchMedia("(prefers-color-scheme: light)").matches
      ? "light"
      : "dark";
  }

  function setTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("gno-theme", theme);
  }

  if (themeToggle) {
    themeToggle.addEventListener("click", function () {
      const currentTheme = document.documentElement.getAttribute("data-theme");
      const newTheme = currentTheme === "dark" ? "light" : "dark";
      setTheme(newTheme);
    });
  }

  // Listen for system theme changes
  window
    .matchMedia("(prefers-color-scheme: dark)")
    .addEventListener("change", function (e) {
      if (!localStorage.getItem("gno-theme")) {
        setTheme(e.matches ? "dark" : "light");
      }
    });

  // ==========================================================================
  // Mobile Menu / Sidebar Toggle
  // ==========================================================================

  const mobileMenuToggle = document.getElementById("mobile-menu-toggle");
  const sidebar = document.getElementById("sidebar");
  const sidebarOverlay = document.getElementById("sidebar-overlay");

  function openSidebar() {
    sidebar.classList.add("open");
    sidebarOverlay.classList.add("visible");
    mobileMenuToggle.classList.add("active");
    mobileMenuToggle.setAttribute("aria-expanded", "true");
    document.body.style.overflow = "hidden";
  }

  function closeSidebar() {
    sidebar.classList.remove("open");
    sidebarOverlay.classList.remove("visible");
    mobileMenuToggle.classList.remove("active");
    mobileMenuToggle.setAttribute("aria-expanded", "false");
    document.body.style.overflow = "";
  }

  if (mobileMenuToggle && sidebar) {
    mobileMenuToggle.addEventListener("click", function () {
      const isOpen = sidebar.classList.contains("open");
      if (isOpen) {
        closeSidebar();
      } else {
        openSidebar();
      }
    });
  }

  if (sidebarOverlay) {
    sidebarOverlay.addEventListener("click", closeSidebar);
  }

  // Close sidebar on ESC
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && sidebar && sidebar.classList.contains("open")) {
      closeSidebar();
    }
  });

  // ==========================================================================
  // Smooth Scroll for Anchor Links
  // ==========================================================================

  document.querySelectorAll('a[href^="#"]').forEach(function (anchor) {
    anchor.addEventListener("click", function (e) {
      const targetId = this.getAttribute("href");
      if (targetId === "#") return;

      const target = document.querySelector(targetId);
      if (target) {
        e.preventDefault();
        target.scrollIntoView({
          behavior: "smooth",
          block: "start",
        });
        // Update URL without scrolling
        history.pushState(null, null, targetId);
      }
    });
  });

  // ==========================================================================
  // Copy Code Button
  // ==========================================================================

  function addCopyButtons() {
    document.querySelectorAll("pre").forEach(function (pre) {
      // Skip if already has copy button
      if (pre.querySelector(".copy-btn")) return;

      const button = document.createElement("button");
      button.className = "copy-btn";
      button.textContent = "Copy";
      button.setAttribute("aria-label", "Copy code to clipboard");

      button.addEventListener("click", async function () {
        const code = pre.querySelector("code");
        const text = code ? code.textContent : pre.textContent;

        try {
          await navigator.clipboard.writeText(text);
          button.textContent = "Copied!";
          button.classList.add("copied");

          setTimeout(function () {
            button.textContent = "Copy";
            button.classList.remove("copied");
          }, 2000);
        } catch (err) {
          button.textContent = "Failed";
          setTimeout(function () {
            button.textContent = "Copy";
          }, 2000);
        }
      });

      pre.style.position = "relative";
      pre.appendChild(button);
    });
  }

  // Run on page load
  addCopyButtons();

  // ==========================================================================
  // Image Lightbox
  // ==========================================================================

  function initLightbox() {
    // Create lightbox elements
    var lightbox = document.createElement("div");
    lightbox.className = "lightbox";
    lightbox.innerHTML =
      '<div class="lightbox-backdrop"></div>' +
      '<div class="lightbox-content">' +
      '<img class="lightbox-img" src="" alt="">' +
      '<button class="lightbox-close" aria-label="Close lightbox">&times;</button>' +
      "</div>";
    document.body.appendChild(lightbox);

    var lightboxImg = lightbox.querySelector(".lightbox-img");
    var backdrop = lightbox.querySelector(".lightbox-backdrop");
    var closeBtn = lightbox.querySelector(".lightbox-close");

    function openLightbox(src, alt) {
      lightboxImg.src = src;
      lightboxImg.alt = alt || "";
      lightbox.classList.add("open");
      document.body.style.overflow = "hidden";
    }

    function closeLightbox() {
      lightbox.classList.remove("open");
      document.body.style.overflow = "";
    }

    // Click handlers
    backdrop.addEventListener("click", closeLightbox);
    closeBtn.addEventListener("click", closeLightbox);

    // ESC to close
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && lightbox.classList.contains("open")) {
        closeLightbox();
      }
    });

    // Make content images clickable (screenshots)
    document
      .querySelectorAll(".content img, .content-home img, .page-content img")
      .forEach(function (img) {
        // Skip small images, icons, or already-processed
        if (img.classList.contains("lightbox-enabled")) return;
        if (img.naturalWidth < 200) return;

        img.classList.add("lightbox-enabled");
        img.style.cursor = "zoom-in";
        img.setAttribute("tabindex", "0");
        img.setAttribute("role", "button");
        img.setAttribute("aria-label", "Click to enlarge image");

        img.addEventListener("click", function () {
          openLightbox(this.src, this.alt);
        });

        img.addEventListener("keydown", function (e) {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            openLightbox(this.src, this.alt);
          }
        });
      });
  }

  // Run after images load
  if (document.readyState === "complete") {
    initLightbox();
  } else {
    window.addEventListener("load", initLightbox);
  }

  // ==========================================================================
  // External Links
  // ==========================================================================

  // Add external link indicator and security attributes
  document.querySelectorAll('a[href^="http"]').forEach(function (link) {
    if (!link.hostname.includes(window.location.hostname)) {
      link.setAttribute("target", "_blank");
      link.setAttribute("rel", "noopener noreferrer");
    }
  });

  // ==========================================================================
  // Scroll-Triggered Animations
  // ==========================================================================

  // Only run if user hasn't requested reduced motion
  if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    var animatedElements = document.querySelectorAll(
      ".feature-card, .demo-full, .section-title, .animate-on-scroll, .step-card, .use-case-card, .integration-item"
    );

    if (animatedElements.length > 0 && "IntersectionObserver" in window) {
      var observer = new IntersectionObserver(
        function (entries) {
          entries.forEach(function (entry) {
            if (entry.isIntersecting) {
              entry.target.classList.add("is-visible");
              // Unobserve after animation to save resources
              observer.unobserve(entry.target);
            }
          });
        },
        {
          root: null,
          rootMargin: "0px 0px -50px 0px",
          threshold: 0.1,
        }
      );

      animatedElements.forEach(function (el) {
        observer.observe(el);
      });
    } else {
      // Fallback: show all elements immediately
      animatedElements.forEach(function (el) {
        el.classList.add("is-visible");
      });
    }
  } else {
    // Reduced motion: show all elements immediately
    document
      .querySelectorAll(
        ".feature-card, .demo-full, .section-title, .animate-on-scroll, .step-card, .use-case-card, .integration-item"
      )
      .forEach(function (el) {
        el.classList.add("is-visible");
      });
  }
})();
