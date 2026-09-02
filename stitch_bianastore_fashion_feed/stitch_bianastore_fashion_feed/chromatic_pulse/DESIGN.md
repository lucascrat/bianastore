---
name: Chromatic Pulse
colors:
  surface: '#f8f9fa'
  surface-dim: '#d9dadb'
  surface-bright: '#f8f9fa'
  surface-container-lowest: '#ffffff'
  surface-container-low: '#f3f4f5'
  surface-container: '#edeeef'
  surface-container-high: '#e7e8e9'
  surface-container-highest: '#e1e3e4'
  on-surface: '#191c1d'
  on-surface-variant: '#5a4044'
  inverse-surface: '#2e3132'
  inverse-on-surface: '#f0f1f2'
  outline: '#8e6f74'
  outline-variant: '#e3bdc3'
  surface-tint: '#bc004f'
  primary: '#b0004a'
  on-primary: '#ffffff'
  primary-container: '#d81b60'
  on-primary-container: '#fff2f3'
  inverse-primary: '#ffb2bf'
  secondary: '#5f5e5e'
  on-secondary: '#ffffff'
  secondary-container: '#e2dfde'
  on-secondary-container: '#636262'
  tertiary: '#ad0059'
  on-tertiary: '#ffffff'
  tertiary-container: '#d12672'
  on-tertiary-container: '#fff2f3'
  error: '#ba1a1a'
  on-error: '#ffffff'
  error-container: '#ffdad6'
  on-error-container: '#93000a'
  primary-fixed: '#ffd9de'
  primary-fixed-dim: '#ffb2bf'
  on-primary-fixed: '#3f0016'
  on-primary-fixed-variant: '#90003b'
  secondary-fixed: '#e5e2e1'
  secondary-fixed-dim: '#c8c6c5'
  on-secondary-fixed: '#1c1b1b'
  on-secondary-fixed-variant: '#474746'
  tertiary-fixed: '#ffd9e2'
  tertiary-fixed-dim: '#ffb1c7'
  on-tertiary-fixed: '#3f001c'
  on-tertiary-fixed-variant: '#8e0048'
  background: '#f8f9fa'
  on-background: '#191c1d'
  surface-variant: '#e1e3e4'
typography:
  display-lg:
    fontFamily: Plus Jakarta Sans
    fontSize: 48px
    fontWeight: '800'
    lineHeight: '1.1'
    letterSpacing: -0.02em
  headline-lg:
    fontFamily: Plus Jakarta Sans
    fontSize: 32px
    fontWeight: '700'
    lineHeight: '1.2'
  headline-lg-mobile:
    fontFamily: Plus Jakarta Sans
    fontSize: 24px
    fontWeight: '700'
    lineHeight: '1.2'
  title-md:
    fontFamily: Plus Jakarta Sans
    fontSize: 18px
    fontWeight: '600'
    lineHeight: '1.4'
  body-lg:
    fontFamily: Hanken Grotesk
    fontSize: 16px
    fontWeight: '400'
    lineHeight: '1.6'
  body-sm:
    fontFamily: Hanken Grotesk
    fontSize: 14px
    fontWeight: '400'
    lineHeight: '1.5'
  label-bold:
    fontFamily: Hanken Grotesk
    fontSize: 12px
    fontWeight: '700'
    lineHeight: '1'
    letterSpacing: 0.05em
  price-tag:
    fontFamily: Plus Jakarta Sans
    fontSize: 20px
    fontWeight: '800'
    lineHeight: '1'
rounded:
  sm: 0.25rem
  DEFAULT: 0.5rem
  md: 0.75rem
  lg: 1rem
  xl: 1.5rem
  full: 9999px
spacing:
  base: 4px
  xs: 8px
  sm: 16px
  md: 24px
  lg: 40px
  xl: 64px
  gutter: 16px
  margin-mobile: 16px
  margin-desktop: 32px
---

## Brand & Style

The design system is engineered for a high-velocity, video-first e-commerce experience that bridges the gap between social entertainment and premium retail. The brand personality is energetic, confident, and "digitally native," mirroring the fast-paced, immersive nature of modern social shopping platforms.

The aesthetic blends **Modern Corporate** precision with **Glassmorphism** and **Tactile** accents. It prioritizes content-driven immersion, where the UI feels like a transparent layer over high-definition video and photography. The emotional response is one of excitement and "instant gratification," achieved through high-contrast accents against a sophisticated, airy backdrop.

## Colors

The palette centers on "Deep Pink," a vibrant, high-chroma primary used strategically for calls-to-action, promotional pricing, and brand markers. 

- **Primary (#D81B60):** Reserved for the "Buy Now" buttons, active states, and urgent price drops.
- **Secondary (#1A1A1A):** Used for high-end typography and grounding elements to maintain a premium feel.
- **Surface Palette:** Employs off-whites (#F8F9FA) and ultra-light grays (#E9ECEF) to create a "gallery" effect, ensuring the colorful apparel and video content remain the focal point.
- **Semantic Accents:** Use a lighter Tertiary Pink (#FF4D94) for "Flash Sale" badges and soft hover states to maintain a monochromatic energy.

## Typography

This design system utilizes a pairing of **Plus Jakarta Sans** for headlines and **Hanken Grotesk** for functional text. This combination provides a balance between playful, rounded geometric forms and clinical, modern legibility.

- **Headlines:** Use tight letter-spacing and heavy weights to create "impact moments" typical of social media overlays.
- **Body:** Hanken Grotesk is set with generous line height to ensure readability during fast scrolling.
- **Pricing:** A specific "price-tag" role is defined with extra weight and the primary brand color to ensure the value proposition is never missed.

## Layout & Spacing

The layout model is a **Fluid Grid** designed to mimic the verticality of mobile feeds even on desktop. 

- **Mobile:** A single-column vertical feed with "edge-to-edge" video content. UI controls (Like, Share, Buy) are treated as floating overlays with a 16px safe-area margin from the screen edges.
- **Desktop:** A 12-column grid where the primary video/image remains centered (spanning 6-8 columns), flanked by floating utility panels. 
- **Rhythm:** Use an 8px base unit. Spacing between cards in a list should be 12px to create a "tight" social-feed aesthetic, while section headers use 40px to provide breathing room.

## Elevation & Depth

To achieve the "TikTok Shop" feel, this design system utilizes **Glassmorphism** and **Ambient Shadows**.

- **Floating Menus:** Use a `backdrop-filter: blur(12px)` with a semi-transparent white fill (`rgba(255, 255, 255, 0.7)`). This allows the colors of the product video to bleed through the navigation.
- **Shadows:** Avoid harsh, black shadows. Use soft, diffused shadows with a slight primary color tint (e.g., `0px 10px 30px rgba(216, 27, 96, 0.08)`) to give elements a "lifted" look without feeling heavy.
- **Layers:** 
    - Level 0: Content/Video (Base)
    - Level 1: Cards and secondary buttons (Surface)
    - Level 2: Floating Tab Bars and Global CTA (Overlay)

## Shapes

The shape language is friendly and highly modern. 
- **Standard Elements:** Buttons and input fields use a `0.5rem` (8px) radius.
- **Product Cards:** Use `rounded-lg` (16px) to create a soft, premium feel that frames the photography.
- **Floating Buttons:** Action buttons like "Add to Cart" should use `rounded-xl` or full pill shapes to signify touch-friendliness and high interactivity.

## Components

- **Buttons:** The primary button is a solid Deep Pink with white text, using a subtle vertical gradient for a "tactile" press effect. Secondary buttons should be ghost-style with a backdrop-blur.
- **Product Cards:** Must include a high-contrast price badge in the bottom left corner. Use a soft shadow to separate the card from the neutral background.
- **Floating Navigation:** A bottom-docked navigation bar for mobile, utilizing glassmorphism and a "glowing" primary color indicator for the active state.
- **Flash Sale Chips:** Small, high-energy tags using the Tertiary Pink. Use "bounce" micro-animations on load to draw attention to limited-time offers.
- **Input Fields:** Minimalist with a light gray fill (#F1F3F5) and a Deep Pink border that appears only on focus.
- **Video Overlays:** Use white icons with a subtle text shadow (0px 2px 4px) to ensure visibility against varying video backgrounds.