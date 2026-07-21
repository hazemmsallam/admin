package com.eventticketing.admin.client.dto;

import java.util.List;

public record UpdateHallSeatsRequest(
        Integer layoutWidth,
        Integer layoutHeight,
        List<SeatEditItem> seats
) {
}
