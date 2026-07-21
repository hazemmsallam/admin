package com.eventticketing.admin.web;

import com.eventticketing.admin.client.TicketingClient;
import org.springframework.stereotype.Controller;
import org.springframework.ui.Model;
import org.springframework.web.bind.annotation.GetMapping;

@Controller
public class DashboardController {

    private final TicketingClient client;

    public DashboardController(TicketingClient client) {
        this.client = client;
    }

    @GetMapping("/")
    public String dashboard(Model model) {
        model.addAttribute("organizerCount", client.listOrganizers().size());
        model.addAttribute("hallCount", client.listHalls().size());
        model.addAttribute("eventCount", client.listEvents().size());
        return "dashboard";
    }
}
