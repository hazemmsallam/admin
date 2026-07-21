package com.eventticketing.admin.client.dto;

public record SeatLayoutItem(
        Long id,
        Integer layoutX,
        Integer layoutY,
        Integer rotationDegrees,
        Integer layoutWidth,
        Integer layoutHeight,
        String sectionName,
        String seatType
) {
}
