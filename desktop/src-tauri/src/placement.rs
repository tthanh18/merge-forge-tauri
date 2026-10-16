use serde::{Deserialize, Serialize};

/// Last window frame, in physical pixels. Coordinates may be negative on a left-hand display.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Frame {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// A connected display's usable area, menu bar and dock already removed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Screen {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// Where the next merge window should open.
///
/// Same frame when its title bar still sits on a connected display, so a window
/// enlarged on the big screen comes back there. If that display is gone, keep
/// the size but pull the window onto the largest remaining screen.
pub fn choose_frame(saved: Frame, screens: &[Screen]) -> Frame {
    if screens.is_empty() || screens.iter().any(|screen| title_visible(saved, *screen)) {
        return saved;
    }
    let host = screens
        .iter()
        .max_by_key(|screen| screen.width as u64 * screen.height as u64)
        .expect("screens is non-empty");
    fit(saved, *host)
}

fn title_visible(frame: Frame, screen: Screen) -> bool {
    let band = Rect {
        x: frame.x,
        y: frame.y,
        width: frame.width.min(320) as i32,
        height: 48,
    };
    intersection_area(band, screen.into()) >= 48 * 24
}

fn fit(frame: Frame, screen: Screen) -> Frame {
    let width = clamp_span(frame.width, screen.width, 960);
    let height = clamp_span(frame.height, screen.height, 640);
    let x = clamp_origin(frame.x, screen.x, screen.width, width);
    let y = clamp_origin(frame.y, screen.y, screen.height, height);
    Frame {
        x,
        y,
        width,
        height,
    }
}

fn clamp_span(saved: u32, available: u32, preferred_min: u32) -> u32 {
    let available = available.max(1);
    let floor = preferred_min.min(available);
    saved.clamp(floor, available)
}

fn clamp_origin(saved: i32, screen: i32, screen_span: u32, window_span: u32) -> i32 {
    let end = screen + screen_span as i32 - window_span as i32;
    saved.clamp(screen, end.max(screen))
}

#[derive(Clone, Copy)]
struct Rect {
    x: i32,
    y: i32,
    width: i32,
    height: i32,
}

impl From<Screen> for Rect {
    fn from(screen: Screen) -> Self {
        Self {
            x: screen.x,
            y: screen.y,
            width: screen.width as i32,
            height: screen.height as i32,
        }
    }
}

fn intersection_area(a: Rect, b: Rect) -> i32 {
    let left = a.x.max(b.x);
    let top = a.y.max(b.y);
    let right = (a.x + a.width).min(b.x + b.width);
    let bottom = (a.y + a.height).min(b.y + b.height);
    (right - left).max(0) * (bottom - top).max(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn screen(x: i32, y: i32, width: u32, height: u32) -> Screen {
        Screen {
            x,
            y,
            width,
            height,
        }
    }

    #[test]
    fn keeps_a_large_window_on_the_external_display() {
        let laptop = screen(0, 0, 1512, 900);
        let external = screen(-2560, 0, 2560, 1440);
        let saved = Frame {
            x: -2400,
            y: 40,
            width: 2200,
            height: 1300,
        };
        assert_eq!(choose_frame(saved, &[laptop, external]), saved);
    }

    #[test]
    fn pulls_onto_the_remaining_screen_when_the_big_one_is_unplugged() {
        let laptop = screen(0, 0, 1512, 900);
        let saved = Frame {
            x: -2400,
            y: 40,
            width: 2200,
            height: 1300,
        };
        assert_eq!(
            choose_frame(saved, &[laptop]),
            Frame {
                x: 0,
                y: 0,
                width: 1512,
                height: 900
            }
        );
    }

    #[test]
    fn keeps_the_saved_size_when_no_display_info_is_available() {
        let saved = Frame {
            x: 10,
            y: 20,
            width: 1800,
            height: 1000,
        };
        assert_eq!(choose_frame(saved, &[]), saved);
    }
}
