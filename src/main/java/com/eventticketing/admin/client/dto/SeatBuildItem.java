package com.eventticketing.admin.client.dto;

/**
 * One seat as arranged in the create-page builder. Keyed by row/column ({@code r}/{@code c})
 * because seat IDs do not exist until the hall is created; the controller maps these to the
 * generated seat IDs and forwards them as {@link SeatLayoutItem}s.
 */
public record SeatBuildItem(
        int r,
        int c,
        int x,
        int y,
        int rot,
        int w,
        int h,
        String section
) {
}
