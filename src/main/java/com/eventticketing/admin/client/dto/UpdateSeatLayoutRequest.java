package com.eventticketing.admin.client.dto;

import java.util.List;

public record UpdateSeatLayoutRequest(
        Integer layoutWidth,
        Integer layoutHeight,
        List<SeatLayoutItem> seats
) {
}
